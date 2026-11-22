import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const home = await mkdtemp(join(tmpdir(), "workbench-http-layout-"));
const app = await createApp({ root: home, port: 0 });
const origin = new URL(app.launchUrl).origin;
const forbidden = [],
  errors = [];
let browser;
try {
  let owner = await app.store.create("布局验证");
  owner.requests = [
    normalizeRequest({
      id: "verification",
      name: "Verification",
      method: "GET",
      url: "",
      bodyType: "none",
    }),
    normalizeRequest({
      id: "second",
      name: "Second request",
      method: "GET",
      url: "",
      bodyType: "none",
    }),
  ];
  owner = await app.store.save(owner);
  const baseline = await app.store.get(owner.id);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  await page.addInitScript((ownerId) => {
    sessionStorage.setItem("project", ownerId);
    const rawSet = Storage.prototype.setItem;
    const layoutWrites = [];
    window.fixtureLayoutWrites = layoutWrites;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === "response-layout")
        layoutWrites.push(value);
      rawSet.call(this, key, value);
    };
  }, owner.id);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const request = route.request();
    if (new URL(request.url()).origin === origin && request.method() === "GET")
      return route.continue();
    forbidden.push(request.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const editor = page.locator("[data-http-response-layout]");
  const requestPanel = editor.locator(".request-panel");
  const response = editor.locator(".response");
  const trigger = response.getByRole("button", {
    name: "请求和响应布局",
    exact: true,
  });
  const menu = page.getByRole("menu", {
    name: "选择请求和响应布局",
    exact: true,
  });
  const stacked = menu.getByRole("menuitemradio", {
    name: "上下分屏",
    exact: true,
  });
  const split = menu.getByRole("menuitemradio", {
    name: "左右分屏",
    exact: true,
  });
  const bodyTab = editor.locator('[data-param="body"]');
  const resultTab = response.getByRole("button", {
    name: "实时响应",
    exact: true,
  });
  const headerTab = response.getByRole("button", {
    name: "响应头",
    exact: true,
  });
  const name = editor.getByRole("textbox", { name: "接口名称", exact: true });
  const saved = page.locator("#saved-state");
  const footer = page.locator("#response-layout");
  const focus = (el) => el.evaluate((node) => node === document.activeElement);
  const preference = () =>
    page.evaluate(() => localStorage.getItem("response-layout"));
  const writes = () => page.evaluate(() => window.fixtureLayoutWrites.slice());
  const capture = async (label) => {
    const target = process.env.HTTP_RESPONSE_LAYOUT_EVIDENCE;
    if (!target) return;
    await mkdir(target, { recursive: true });
    await page.screenshot({
      path: join(target, "http-response-layout-" + label + ".png"),
      caret: "hide",
      animations: "disabled",
    });
  };

  await page.locator('[data-request="verification"]').click();
  await page.locator('[data-mode="debug"]').press("Enter");
  await bodyTab.press("Enter");
  await resultTab.press("Enter");
  assert.equal(await bodyTab.getAttribute("aria-pressed"), "true");
  assert.equal(await resultTab.getAttribute("aria-pressed"), "true");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  const initialControl = await trigger.boundingBox();
  console.log("HTTP_RESPONSE_LAYOUT_CONTROL", JSON.stringify(initialControl));
  await capture("stacked");
  assert(
    Math.abs(initialControl.x - 1303) <= 3 &&
      Math.abs(initialControl.y - 924) <= 10,
  );
  assert.equal(initialControl.width, 34);
  assert.equal(initialControl.height, 32);

  await trigger.press("Enter");
  await menu.waitFor();
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.equal(await stacked.getAttribute("aria-checked"), "true");
  assert.equal(await focus(stacked), true);
  const popover = await menu.boundingBox();
  console.log("HTTP_RESPONSE_LAYOUT_MENU", JSON.stringify(popover));
  await capture("menu");
  assert(Math.abs(popover.x - 1191) <= 4 && Math.abs(popover.y - 895) <= 11);
  assert(popover.x + popover.width < initialControl.x);
  await stacked.press("ArrowDown");
  assert.equal(await focus(split), true);
  await split.press("Enter");
  assert.equal(await split.getAttribute("aria-checked"), "true");
  assert.equal(
    await menu.isVisible(),
    true,
    "native choice retains the open menu",
  );
  assert.equal(await focus(split), true);
  assert.equal(await preference(), "split");
  const splitBounds = await response.boundingBox();
  console.log(
    "HTTP_RESPONSE_LAYOUT_SPLIT",
    JSON.stringify({
      request: await requestPanel.boundingBox(),
      response: splitBounds,
    }),
  );
  await capture("split");
  assert(Math.abs(splitBounds.x - 858) <= 3);
  assert.equal(await bodyTab.getAttribute("aria-pressed"), "true");
  assert.equal(await resultTab.getAttribute("aria-pressed"), "true");
  await split.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await focus(trigger), true);
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await trigger.click();
  await name.click();
  await menu.waitFor({ state: "hidden" });
  assert.equal(await focus(name), true);

  await name.fill("Unsaved synthetic draft");
  await headerTab.press("Enter");
  await headerTab.evaluate((node) => {
    node.closest(".response-tabs").scrollLeft = 22;
  });
  const tabScroll = () =>
    headerTab.evaluate((node) => node.closest(".response-tabs").scrollLeft);
  const oldScroll = await tabScroll();
  const nameIdentity = await name.elementHandle();
  await trigger.press("ArrowDown");
  await split.press("Home");
  assert.equal(await focus(stacked), true);
  await stacked.press("Enter");
  assert.equal(await stacked.getAttribute("aria-checked"), "true");
  assert.equal(
    await nameIdentity.evaluate((node) => node.isConnected),
    true,
    "layout does not re-render input/draft",
  );
  assert.equal(await name.inputValue(), "Unsaved synthetic draft");
  assert.equal(await headerTab.getAttribute("aria-pressed"), "true");
  assert.equal(await bodyTab.getAttribute("aria-pressed"), "true");
  // A wider pane may legitimately clamp the previous scroll offset to zero.
  assert((await tabScroll()) <= oldScroll);
  assert.match(await saved.textContent(), /未保存/);
  await stacked.press("Tab");
  await menu.waitFor({ state: "hidden" });

  await footer.press("Enter");
  assert.equal(await preference(), "split");
  assert.equal(await footer.getAttribute("aria-pressed"), "true");
  assert.deepEqual(await writes(), ["split", "stacked", "split"]);
  await resultTab.press("Enter");
  await page.setViewportSize({ width: 430, height: 830 });
  await page.waitForFunction(
    () =>
      !document
        .querySelector("[data-http-response-layout]")
        .classList.contains("split-layout"),
  );
  assert.equal(
    await preference(),
    "split",
    "narrow effective fallback never rewrites preference",
  );
  assert.equal(await footer.isDisabled(), true);
  await trigger.press("Enter");
  await menu.waitFor();
  assert.equal(await stacked.getAttribute("aria-checked"), "true");
  assert.equal(await split.isDisabled(), true);
  const narrow = await menu.boundingBox();
  await capture("narrow");
  assert(narrow.x >= 8 && narrow.x + narrow.width <= 422);
  assert(narrow.y >= 8 && narrow.y + narrow.height <= 822);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await stacked.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await focus(trigger), true);
  assert.equal(await name.inputValue(), "Unsaved synthetic draft");

  await page.reload();
  await page.locator('[data-request="verification"]').press("Enter");
  await page.locator('[data-mode="debug"]').press("Enter");
  assert.equal(await preference(), "split");
  assert.equal(await footer.getAttribute("aria-pressed"), "false");
  assert.equal(
    await name.inputValue(),
    "Verification",
    "never saved the draft",
  );
  await page.setViewportSize({ width: 1363, height: 1023 });
  await page.waitForFunction(() =>
    document
      .querySelector("[data-http-response-layout]")
      .classList.contains("split-layout"),
  );
  assert.equal(await footer.getAttribute("aria-pressed"), "true");
  assert.deepEqual(await writes(), [], "restoring stored layout never writes");
  await page.locator('[data-mode="design"]').press("Enter");
  assert.equal(await trigger.count(), 0);
  assert.deepEqual(await app.store.get(owner.id), baseline);
  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  console.log(
    "HTTP_RESPONSE_LAYOUT_UI_PASS real menu, keyboard, focus, no execute or project writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(home, { recursive: true, force: true });
}
