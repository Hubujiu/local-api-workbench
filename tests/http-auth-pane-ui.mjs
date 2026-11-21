import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createApp } from "../src/server.mjs";
import { authTypes } from "../public/auth-model.js";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const root = await mkdtemp("/tmp/workbench-auth-pane-");
const app = await createApp({ root, port: 0 });
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const executed = [];
  const origin = new URL(app.launchUrl).origin;
  await page.route("**/*", (route) => {
    const request = route.request();
    if (
      new URL(request.url()).origin !== origin ||
      /\/execute(?:$|\?)/.test(request.url())
    ) {
      executed.push(request.url());
      return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.goto(app.launchUrl);
  await page.locator("#body-code").waitFor();
  await page.locator('[data-param="auth"]').click();
  const select = page.getByLabel("类型", { exact: true });
  const inheritance = page.locator("#inherit-auth");
  assert.deepEqual(
    await select
      .locator("option")
      .evaluateAll((nodes) => nodes.map((node) => node.value)),
    authTypes,
  );
  assert(await inheritance.isChecked());
  await select.focus();
  await select.selectOption("bearer");
  const token = page.getByLabel("Token", { exact: true });
  assert.equal(await token.getAttribute("type"), "password");
  assert(await select.evaluate((node) => node === document.activeElement));
  const pane = await page.locator(".http-auth-pane").boundingBox();
  const method = await select.boundingBox();
  const field = await token.boundingBox();
  assert.equal(pane.width, 700);
  assert.equal(method.height, 32);
  assert.equal(field.height, 32);
  assert.equal(field.y - method.y, 52);
  assert(Math.abs(method.width - 496) < 1);
  if (process.env.AUTH_PANE_SCREENSHOT) {
    await page.screenshot({
      path: process.env.AUTH_PANE_SCREENSHOT,
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
    });
  }
  await token.fill("{{auth-pane-fixture}}");
  await inheritance.uncheck();
  await select.selectOption("none");
  assert.equal(await inheritance.isChecked(), false);
  await inheritance.check();
  assert.equal(await select.inputValue(), "none");
  await select.selectOption("bearer");
  assert.equal(await token.inputValue(), "{{auth-pane-fixture}}");
  await page.setViewportSize({ width: 640, height: 848 });
  assert(await token.isVisible());
  const narrow = await page.locator(".http-auth-pane").boundingBox();
  const narrowToken = await token.boundingBox();
  assert(narrowToken.width <= narrow.width);
  assert.deepEqual(executed, []);
  console.log(JSON.stringify({ pane, method, field, narrow, narrowToken }));
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
