import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { debugAuthChoices } from "../public/debug-auth-choice.js";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const root = await mkdtemp("/tmp/workbench-auth-pane-");
const app = await createApp({ root, port: 0 });
let browser;
try {
  const project = await app.store.create("认证工作台验证");
  const source = normalizeRequest({
    id: "debug-auth-fixture",
    name: "创建用户",
    method: "POST",
    url: "http://127.0.0.1:39032/users",
  });
  const frozen = normalizeRequest({
    id: "frozen-auth-fixture",
    name: "固定认证",
    authSnapshot: true,
  });
  project.requests.push(source, frozen);
  // Test precedence without a credential or a configured remote service.
  project.settings.globalAuth = { type: "basic", username: "synthetic-only" };
  await app.store.save(project);

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const disallowed = [];
  const puts = [];
  const errors = [];
  const origin = new URL(app.launchUrl).origin;
  const screenshotDir = process.env.AUTH_PANE_SCREENSHOT_DIR;
  const capturesOnly = process.env.AUTH_PANE_SCREENSHOT_ONLY === "1";
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    if (
      !capturesOnly &&
      url.origin === origin &&
      url.pathname === "/api/projects/" + project.id &&
      request.method() === "PUT"
    ) {
      puts.push(request.postDataJSON());
      return route.continue();
    }
    disallowed.push(request.method() + " " + url.pathname);
    return route.abort();
  });
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.goto(app.launchUrl);
  const authTab = page.locator('[data-param="auth"]');
  await authTab.click();
  const select = page.getByLabel("类型", { exact: true });
  const token = page.getByLabel("Token", { exact: true });
  const focused = (locator) =>
    locator.evaluate((node) => node === document.activeElement);
  const screenshot = (mode, fallback) => {
    const file = screenshotDir
      ? join(screenshotDir, "auth-workbench-" + mode + ".png")
      : fallback;
    if (file)
      return page.screenshot({
        path: file,
        clip: { x: 0, y: 0, width: 1363, height: 980 },
        caret: "hide",
        animations: "disabled",
      });
  };
  assert.deepEqual(
    await select
      .locator("option")
      .evaluateAll((nodes) => nodes.map((node) => node.value)),
    debugAuthChoices,
  );
  assert.equal(await select.inputValue(), "inherit");
  assert.equal(await page.locator("#inherit-auth").count(), 0);
  await page.mouse.move(1000, 170);
  await screenshot("inherit");
  await select.selectOption("none");
  assert.equal(await token.count(), 0);
  await screenshot("none");
  await select.focus();
  await select.selectOption("bearer");
  assert.equal(await token.inputValue(), "");
  assert.equal(await token.getAttribute("type"), "password");
  assert(await focused(select));
  const pane = await page.locator(".http-auth-pane").boundingBox();
  const method = await select.boundingBox();
  const field = await token.boundingBox();
  assert.equal(pane.width, 700);
  assert.equal(method.height, 32);
  assert.equal(field.height, 32);
  assert.equal(field.y - method.y, 52);
  assert(Math.abs(method.width - 496) < 1);
  await screenshot("bearer-empty", process.env.AUTH_PANE_SCREENSHOT);

  if (!capturesOnly) {
    await token.fill("{{synthetic-debug-auth}}");
    await select.selectOption("oauth2");
    assert.equal(await page.locator('[data-auth="token"]').inputValue(), "");
    await select.selectOption("inherit");
    assert.equal(await token.count(), 0);
    await select.selectOption("bearer");
    assert.equal(await token.inputValue(), "{{synthetic-debug-auth}}");
    for (const width of [680, 360]) {
      await page.setViewportSize({ width, height: 848 });
      assert(await token.isVisible());
      const narrow = await page.locator(".http-auth-pane").boundingBox();
      const narrowToken = await token.boundingBox();
      assert(narrowToken.width <= narrow.width);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth),
        width,
      );
      await select.focus();
      await select.press("Tab");
      assert(
        await focused(token),
        "native focus order reaches Token from the method control",
      );
      await token.press("Shift+Tab");
      assert(await focused(select));
    }
    await select.selectOption("inherit");
    await select.press("ArrowDown");
    if (await select.evaluate((element) => element.matches(":open"))) {
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
    }
    assert.equal(
      await select.inputValue(),
      "none",
      "keyboard selects explicit no auth",
    );
    assert(await focused(select));
    assert.deepEqual(puts, []);

    await page.locator("#save").click();
    await page
      .locator("#saved-state")
      .getByText("✓ 已保存", { exact: true })
      .waitFor();
    assert.equal(puts.length, 1);
    const savedNone = puts[0].requests.find((item) => item.id === source.id);
    assert.equal(savedNone.inheritAuth, false);
    assert.equal(savedNone.authSnapshot, false);
    assert.deepEqual(savedNone.auth, { type: "none" });
    assert.doesNotMatch(JSON.stringify(puts[0]), /synthetic-debug-auth/);
    await select.selectOption("bearer");
    assert.equal(
      await token.inputValue(),
      "{{synthetic-debug-auth}}",
      "save receipts retain same-editor dormant drafts",
    );
    await page.reload();
    await authTab.click();
    assert.equal(
      await select.inputValue(),
      "none",
      "explicit no auth survives reload",
    );
    await select.selectOption("bearer");
    assert.equal(
      await token.inputValue(),
      "",
      "a discarded inactive draft was never written",
    );

    await page.locator('[data-request="' + frozen.id + '"]').click();
    await authTab.click();
    assert.equal(await select.inputValue(), "none");
    assert(await select.locator('option[value="inherit"]').isDisabled());
    await page
      .getByText("此请求的认证已固定，不能继承父级。", { exact: true })
      .waitFor();
    assert.equal(puts.length, 1);
  }
  assert.deepEqual(disallowed, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      pane,
      method,
      field,
      writes: puts.length,
      errors,
      disallowed,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
