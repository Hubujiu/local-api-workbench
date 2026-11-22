import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const root = await mkdtemp("/tmp/workbench-environment-modal-");
const app = await createApp({ root, port: 0 });
let browser;
let releaseHeld;
async function settled(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("held Cookie read fixture timeout")),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  const project = await app.store.create("环境工作台验证");
  const environment = project.environments[0];
  environment.variables = {};
  project.servers = [{ id: "fixture-default-service", name: "默认服务" }];
  const request = normalizeRequest({
    id: "environment-workspace-source",
    name: "Verification",
    method: "GET",
    url: "http://127.0.0.1:39031/verification",
  });
  project.requests.push(request);
  await app.store.save(project);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const origin = new URL(app.launchUrl).origin;
  const cookiePath = "/api/projects/" + project.id + "/cookies";
  const cookieReads = [];
  const disallowed = [];
  const errors = [];
  let hold, gotHeld, finishedHeld, heldError;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") {
      disallowed.push(request.method() + " " + url.pathname);
      return route.abort();
    }
    if (url.pathname === cookiePath) {
      cookieReads.push(url.searchParams.get("environmentId"));
      if (hold) {
        hold = false;
        try {
          const response = await route.fetch({ maxRetries: 1 }); // side-effect-free test GET
          if (response.status() !== 200)
            throw Error("Cookie read returned non-200");
          gotHeld();
          await releaseHeld.promise;
          await route.fulfill({ response });
        } catch {
          heldError = Error(
            "held Cookie fixture could not fetch or deliver the local response",
          );
          gotHeld();
        } finally {
          finishedHeld();
        }
        return;
      }
    }
    return route.continue();
  });
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.goto(app.launchUrl);
  await page.locator('[data-param="auth"]').click();
  const launcher = page.getByRole("button", { name: "环境设置", exact: true });
  const dialog = page.locator("#dialog");
  const title = dialog.locator("#dialog-title");
  const navigation = dialog.getByLabel("环境设置导航");
  const cookie = navigation.getByRole("button", {
    name: "Cookie管理器",
    exact: true,
  });
  const defaultEnv = navigation.getByRole("button", {
    name: "默认环境",
    exact: true,
  });
  const input = dialog.getByRole("textbox", { name: "环境名称", exact: true });
  const url = page.locator("#url");
  const captures = process.env.ENVIRONMENT_WORKSPACE_SCREENSHOTS;
  const readyCookie = () =>
    dialog.getByText("暂无 Cookie", { exact: true }).waitFor();
  const focusIs = (locator) =>
    locator.evaluate((el) => document.activeElement === el);
  const screenshot = async (state) => {
    if (captures)
      await page.screenshot({
        path: join(captures, "env-workbench-" + state + ".png"),
        clip: { x: 0, y: 0, width: 1363, height: 980 },
        animations: "disabled",
        caret: "hide",
      });
  };
  await launcher.press("Enter");
  await readyCookie();
  assert.equal(await title.innerText(), "Cookie管理器");
  assert.equal(await cookie.getAttribute("aria-current"), "page");
  assert.equal(
    await page.locator('.rail [data-page="apis"]').getAttribute("aria-current"),
    "page",
  );
  assert.equal(
    await page.locator('[data-mode="debug"]').getAttribute("aria-pressed"),
    "true",
  );
  const modal = await dialog.boundingBox();
  const nav = await navigation.boundingBox();
  assert.equal(modal.width, 955);
  assert.equal(modal.height, 600);
  assert.equal(nav.width, 272);
  await page.mouse.move(1260, 170);
  await screenshot("entry");
  await defaultEnv.press("Enter");
  assert.equal(await title.innerText(), "环境设置");
  assert.equal(await defaultEnv.getAttribute("aria-current"), "page");
  assert.equal(await input.inputValue(), "默认环境");
  assert(await focusIs(input));
  await screenshot("default");
  await input.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.id === "open-environment-settings",
  );
  assert.equal(await url.inputValue(), request.url);

  if (!captures) {
    const dirtyUrl = request.url + "?editor-draft=true";
    await url.fill(dirtyUrl);
    await page.setViewportSize({ width: 430, height: 770 });
    const got = new Promise((resolve) => {
      gotHeld = resolve;
    });
    const done = new Promise((resolve) => {
      finishedHeld = resolve;
    });
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    releaseHeld = { promise, release };
    hold = true;
    await launcher.press("Enter");
    await dialog.getByText("正在读取Cookie…", { exact: true }).waitFor();
    await settled(got);
    if (heldError) throw heldError;
    assert(await focusIs(cookie));
    const narrow = await dialog.boundingBox();
    assert(narrow.x >= 0 && narrow.x + narrow.width <= 430);
    await defaultEnv.press("Enter");
    await input.fill("未提交的环境名称");
    release();
    await settled(done);
    if (heldError) throw heldError;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.equal(await title.innerText(), "环境设置");
    assert.equal(await input.inputValue(), "未提交的环境名称");
    assert.equal(await dialog.locator("#cookie-toggle").count(), 0);
    await input.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => document.activeElement?.id === "open-environment-settings",
    );
    assert.equal(await url.inputValue(), dirtyUrl);
    assert.equal(await page.locator("#env").inputValue(), environment.id);

    await launcher.press("Enter");
    await readyCookie();
    await dialog.getByText("添加 Cookie", { exact: true }).press("Enter");
    const cookieField = dialog.getByLabel("Set-Cookie", { exact: false });
    assert(await cookieField.isVisible());
    assert.equal(await cookieField.getAttribute("type"), "password");
    await defaultEnv.press("Enter");
    assert.equal(await input.inputValue(), "默认环境");
    await cookie.press("Enter");
    await readyCookie();
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => document.activeElement?.id === "open-environment-settings",
    );
    assert.equal(await url.inputValue(), dirtyUrl);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      430,
    );

    await page.locator('[data-param="cookies"]').click();
    await page.locator("#cookie-manager").click();
    await dialog.locator("#cookie-toggle").waitFor();
    assert.equal(
      await navigation.count(),
      0,
      "existing Cookie parameter management is unchanged",
    );
    await dialog.locator("#cookie-toggle").press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1363, height: 1023 });
    await page.locator('.rail [data-page="settings"]').click();
    await page
      .locator('[data-settings-anchor="settings-environments"]')
      .click();
    await page.locator("#add-env").click();
    await dialog.locator("#env-name").waitFor();
    assert.equal(
      await dialog.locator(".environment-dialog--workspace").count(),
      0,
    );
    await dialog.locator("#env-name").press("Escape");
  }
  assert.deepEqual(cookieReads, Array(captures ? 1 : 5).fill(environment.id));
  assert.deepEqual(disallowed, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      modal,
      nav,
      cookieReads: cookieReads.length,
      writes: 0,
      errors,
    }),
  );
} finally {
  releaseHeld?.release();
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
