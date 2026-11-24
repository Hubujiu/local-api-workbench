import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { applySharedAuth } from "../src/shared-auth.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "workbench-http-auth-shared-"));
const evidence = process.env.HTTP_REQUEST_AUTH_EVIDENCE;
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  let project = await app.store.create("HTTP Authentication fixture");
  const main = normalizeRequest({
    id: "auth-main",
    name: "Verification",
    url: "http://127.0.0.1:39032/verification",
  });
  const other = normalizeRequest({ id: "auth-other", name: "Other request" });
  const frozen = normalizeRequest({
    id: "auth-frozen",
    name: "Frozen request",
    authSnapshot: true,
  });
  project.requests.push(main, other, frozen);
  project.settings.globalAuth = { type: "basic", username: "synthetic-parent" };
  await app.store.save(project);
  project = await app.store.get(project.id);
  const before = structuredClone(project);
  assert.deepEqual(
    applySharedAuth(
      project,
      project.requests.find((item) => item.id === main.id),
    ).auth,
    project.settings.globalAuth,
  );
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  page.setDefaultTimeout(8000);
  const writes = [],
    blocked = [],
    errors = [];
  const origin = new URL(app.launchUrl).origin;
  let allowSave = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (
      url.origin === origin &&
      request.method() === "GET" &&
      !/^\/api\/(?:oauth(?:1)?|execute)(?:\/|$)/.test(url.pathname)
    )
      return route.continue();
    if (
      allowSave &&
      writes.length === 0 &&
      url.origin === origin &&
      request.method() === "PUT" &&
      url.pathname === "/api/projects/" + project.id
    ) {
      writes.push(request.postDataJSON());
      return route.continue();
    }
    blocked.push([
      request.method(),
      url.origin === origin ? url.pathname : "external",
    ]);
    return route.abort();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = async (state) => {
    if (evidence)
      await page.screenshot({
        path: join(evidence, `http-request-auth-${state}.png`),
        caret: "hide",
        animations: "disabled",
      });
  };
  const mode = (name) => page.locator(`[data-mode="${name}"]`);
  const designAuth = page.locator('[data-design-parameter="auth"]');
  const debugAuth = page.locator('[data-param="auth"]');
  const choose = page.getByLabel("类型", { exact: true });
  const param = (name) => page.getByLabel(name, { exact: true });
  const ownFocus = (control) =>
    control.evaluate((element) => element === document.activeElement);
  const labels = [
    "继承父级",
    "无需认证",
    "私密键值对",
    "Basic auth",
    "Bearer Token",
    "JWT Bearer",
    "Digest auth",
    "OAuth 1.0",
    "OAuth 2.0",
    "Hawk authentication",
    "AWS Signature",
    "NTLM Authentication [Beta]",
    "Akamai EdgeGrid",
    "ASAP(Atlassian)",
  ];
  const openRequest = (id) =>
    page.locator(`.sidebar [data-request="${id}"]`).click();
  const desktopLayout = async (view, field) => {
    const selector = await choose.boundingBox();
    const input = field && (await field.boundingBox());
    assert.equal(selector.height, 32);
    assert(Math.abs(selector.width - 496) < 1, JSON.stringify(selector));
    const target = view === "design" ? 709 : 713;
    assert(
      Math.abs(selector.x - target) <= 6,
      JSON.stringify({ view, selector }),
    );
    if (input) {
      assert.equal(input.height, 32);
      assert.equal(input.y - selector.y, 52);
      assert.equal(input.x, selector.x);
    }
    return selector;
  };
  const triggerTone = () =>
    choose.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        supportsIcon: CSS.supports("selector(select::picker-icon)"),
        padding: style.paddingInlineStart,
        borderColor: style.borderTopColor,
      };
    });
  const checkMenu = async (name) => {
    assert.deepEqual(await choose.locator("option").allTextContents(), labels);
    const popup = await choose.evaluate((element) => ({
      available:
        CSS.supports("appearance: base-select") &&
        CSS.supports("selector(select::picker(select))"),
      active: getComputedStyle(element).appearance === "base-select",
    }));
    assert.equal(popup.active, popup.available);
    if (popup.active) {
      const current = await choose.inputValue();
      await choose.click();
      await page.waitForFunction(() =>
        document.querySelector("#auth-type")?.matches(":open"),
      );
      assert.equal(
        await choose
          .locator("option")
          .first()
          .evaluate((element) => getComputedStyle(element).minBlockSize),
        "32px",
      );
      await capture(name);
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector("#auth-type")?.matches(":open"),
      );
      assert.equal(await choose.inputValue(), current);
      assert.equal(await ownFocus(choose), true);
    }
    return popup.active;
  };

  await page.goto(app.launchUrl);
  await openRequest(main.id);
  await mode("design").click();
  await designAuth.click();
  assert.equal(await choose.inputValue(), "inherit");
  assert.equal(await page.locator("#inherit-auth").count(), 0);
  const designFrame = await desktopLayout("design");
  const presentation = await triggerTone();
  if (presentation.supportsIcon) {
    assert.equal(presentation.padding, "12px");
    assert.equal(presentation.borderColor, "rgb(234, 233, 226)");
  }
  await capture("design-inherit");
  const styleablePopup = await checkMenu("design-menu");
  await choose.focus();
  await choose.selectOption("apiKey");
  assert.equal(await ownFocus(choose), true);
  const key = param("Key"),
    value = param("Value"),
    location = param("添加位置");
  assert.equal(await key.getAttribute("placeholder"), "键");
  assert.equal(await value.getAttribute("placeholder"), "值（支持变量）");
  assert.equal(await value.getAttribute("type"), "password");
  assert.deepEqual(await location.locator("option").allTextContents(), [
    "Header",
    "Query Params",
  ]);
  assert.equal(await location.inputValue(), "header");
  await capture("design-api-key");
  await location.selectOption("query");
  await key.fill("X-Synthetic");
  await value.fill("synthetic-private-key-value");

  await choose.selectOption("bearer");
  const token = param("Token");
  await desktopLayout("design", token);
  await capture("design-bearer");
  await token.fill("synthetic-design-token");
  await choose.selectOption("basic");
  const username = param("Username"),
    password = param("Password");
  assert.equal(await password.getAttribute("type"), "password");
  assert.equal(await password.inputValue(), "");
  await capture("design-basic");
  await username.fill("synthetic-account");
  await password.fill("synthetic-account-password");
  await choose.selectOption("bearer");
  assert.equal(await token.inputValue(), "synthetic-design-token");
  await mode("debug").click();
  await debugAuth.click();
  assert.equal(await choose.inputValue(), "bearer");
  const debugFrame = await desktopLayout("debug", token);
  assert.equal(await token.getAttribute("type"), "password");
  assert.equal(await token.inputValue(), "synthetic-design-token");
  // Hold no active credential in the desktop screenshot.
  await choose.selectOption("inherit");
  assert.equal(await token.count(), 0);
  await capture("debug-inherit");
  await checkMenu("debug-menu");
  await choose.selectOption("apiKey");
  assert.equal(await location.inputValue(), "query");
  assert.equal(await value.inputValue(), "synthetic-private-key-value");
  await choose.selectOption("basic");
  assert.equal(await password.inputValue(), "synthetic-account-password");
  await choose.selectOption("none");

  await openRequest(other.id);
  await mode("debug").click();
  await debugAuth.click();
  await choose.selectOption("bearer");
  assert.equal(await token.inputValue(), "");
  await choose.selectOption("inherit");
  await openRequest(frozen.id);
  await mode("design").click();
  await designAuth.click();
  assert.equal(await choose.inputValue(), "none");
  assert(await choose.locator('option[value="inherit"]').isDisabled());
  assert.equal(
    await page
      .getByText("此请求的认证已固定，不能继承父级。", { exact: true })
      .isVisible(),
    true,
  );

  await openRequest(main.id);
  await mode("design").click();
  await designAuth.click();
  assert.equal(await choose.inputValue(), "none");
  assert.deepEqual(writes, []);
  assert.deepEqual(await app.store.get(project.id), before);
  allowSave = true;
  await page.locator("#save").click();
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  allowSave = false;
  assert.equal(writes.length, 1);
  assert.doesNotMatch(
    JSON.stringify(writes[0]),
    /synthetic-design-token|synthetic-private-key-value|synthetic-account-password/,
  );
  const saved = await app.store.get(project.id);
  const record = saved.requests.find(({ id }) => id === main.id);
  assert.deepEqual(record.auth, { type: "none" });
  assert.equal(record.inheritAuth, false);
  assert.deepEqual(applySharedAuth(saved, record).auth, { type: "none" });
  await choose.selectOption("bearer");
  assert.equal(await token.inputValue(), "synthetic-design-token");

  await page.reload();
  await openRequest(main.id);
  await mode("design").click();
  await designAuth.click();
  assert.equal(await choose.inputValue(), "none");
  await page.setViewportSize({ width: 430, height: 780 });
  await choose.selectOption("bearer");
  assert.equal(await token.inputValue(), "");
  await choose.focus();
  await choose.press("Tab");
  assert.equal(await ownFocus(token), true);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await capture("narrow-design");
  await mode("debug").click();
  await debugAuth.click();
  await choose.focus();
  await choose.press("Tab");
  assert.equal(await ownFocus(token), true);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await capture("narrow-debug");
  await checkMenu("narrow-menu");
  await page.emulateMedia({ forcedColors: "active" });
  assert.equal(
    await choose.evaluate(() => matchMedia("(forced-colors: active)").matches),
    true,
  );
  assert.notEqual(
    (await triggerTone()).padding,
    "12px",
    "decorative styling yields to forced colors",
  );
  assert.equal((await choose.boundingBox()).height, 32);
  assert.equal(await choose.inputValue(), "bearer");
  await choose.focus();
  await choose.press("Tab");
  assert.equal(await ownFocus(token), true);
  assert.equal(await token.getAttribute("type"), "password");
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  assert.equal(writes.length, 1);
  console.log(
    "HTTP_REQUEST_AUTH_SHARED_UI_PASS",
    JSON.stringify({ designFrame, debugFrame, styleablePopup }),
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
}
