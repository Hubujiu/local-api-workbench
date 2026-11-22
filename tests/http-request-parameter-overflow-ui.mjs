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
const home = await mkdtemp(join(tmpdir(), "workbench-tab-overflow-"));
const app = await createApp({ root: home, port: 0 });
const origin = new URL(app.launchUrl).origin;
const blocked = [],
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
      id: "other",
      name: "Other",
      method: "POST",
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
  await page.addInitScript((id) => {
    sessionStorage.setItem("project", id);
    localStorage.setItem("response-layout", "split");
  }, owner.id);
  await page.route("**/*", (route) => {
    const req = route.request();
    if (new URL(req.url()).origin === origin && req.method() === "GET")
      return route.continue();
    blocked.push(req.method());
    return route.abort();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.launchUrl);
  const editor = page.locator("[data-http-response-layout]");
  const strip = editor.getByRole("group", { name: "请求参数", exact: true });
  const tab = (key) => strip.locator(`[data-param="${key}"]`);
  const trigger = editor.getByRole("button", {
    name: "更多请求参数标签",
    exact: true,
  });
  const menu = page.getByRole("menu", {
    name: "更多请求参数标签",
    exact: true,
  });
  const menuItem = (title) =>
    menu.getByRole("menuitemradio", { name: title, exact: true });
  const choices = menu.getByRole("menuitemradio");
  const name = editor.getByRole("textbox", { name: "接口名称", exact: true });
  const url = editor.getByRole("textbox", { name: "请求 URL", exact: true });
  const raw = editor.getByRole("textbox", { name: "请求体", exact: true });
  const rawType = editor.getByRole("combobox", {
    name: "请求正文类型",
    exact: true,
  });
  const active = (el) => el.evaluate((node) => node === document.activeElement);
  const capture = async (label) => {
    const target = process.env.HTTP_REQUEST_PARAMETER_OVERFLOW_EVIDENCE;
    if (!target) return;
    await mkdir(target, { recursive: true });
    await page.screenshot({
      path: join(target, "http-request-overflow-" + label + ".png"),
      caret: "hide",
      animations: "disabled",
    });
  };
  const expectedKeys = () =>
    strip.evaluate((node) => {
      const { left, right } = node.getBoundingClientRect();
      return [...node.querySelectorAll("[data-param]")]
        .filter((control) => {
          const bounds = control.getBoundingClientRect();
          return bounds.left < left - 1 || bounds.right > right + 1;
        })
        .map((control) => control.dataset.param);
    });
  const actualKeys = () =>
    choices.evaluateAll((nodes) =>
      nodes.map((node) => node.dataset.overflowParam),
    );
  const assertFull = (key) =>
    tab(key).evaluate((node) => {
      const item = node.getBoundingClientRect();
      const pane = node.closest(".param-tabs").getBoundingClientRect();
      return item.left >= pane.left - 1 && item.right <= pane.right + 1;
    });

  await page.locator('[data-request="verification"]').click();
  await page.locator('[data-mode="debug"]').press("Enter");
  await tab("body").press("Enter");
  assert.equal(await tab("body").getAttribute("aria-pressed"), "true");
  await trigger.waitFor();
  const initial = await trigger.boundingBox();
  console.log("HTTP_REQUEST_OVERFLOW_TRIGGER", JSON.stringify(initial));
  await capture("closed-desktop");
  assert(Math.abs(initial.x + initial.width / 2 - 818) <= 4);
  assert(Math.abs(initial.y + initial.height / 2 - 199) <= 5);
  assert.equal(await strip.locator("[data-param]").count(), 11);
  await trigger.press("ArrowDown");
  await menu.waitFor();
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.deepEqual(await actualKeys(), await expectedKeys());
  assert.equal(await menuItem("预执行操作").isVisible(), true);
  assert.equal(await menuItem("后执行操作").isVisible(), true);
  assert.equal(
    await menuItem("断言").isVisible(),
    true,
    "Workbench-only real tabs are never hidden",
  );
  const menuBounds = await menu.boundingBox();
  console.log("HTTP_REQUEST_OVERFLOW_MENU", JSON.stringify(menuBounds));
  await capture("open-desktop");
  assert(
    Math.abs(menuBounds.x - 795) <= 4 && Math.abs(menuBounds.y - 221) <= 5,
  );
  assert.equal(menuBounds.width, 119);
  await menuItem("预执行操作").press("ArrowDown");
  assert.equal(await active(menuItem("后执行操作")), true);
  await menuItem("后执行操作").press("Enter");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await tab("after").getAttribute("aria-pressed"), "true");
  assert.equal(await active(tab("after")), true);
  assert.equal(await assertFull("after"), true);
  assert.equal((await expectedKeys()).includes("headers"), true);
  assert.equal(await editor.locator("#script-code").isVisible(), true);
  await capture("selected-desktop");

  await trigger.press("Enter");
  await menu.waitFor();
  assert.deepEqual(await actualKeys(), await expectedKeys());
  assert.equal(await menuItem("Header").isVisible(), true);
  await menuItem("Header").press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await active(trigger), true);
  assert.equal(await tab("after").getAttribute("aria-pressed"), "true");
  await trigger.click();
  await menu.waitFor();
  await name.click();
  await menu.waitFor({ state: "hidden" });
  assert.equal(await active(name), true);

  await tab("body").press("Enter");
  await rawType.selectOption("raw");
  const draft = '{ "fixture": "unsaved", "number": 9007199254740993 }';
  await raw.fill(draft);
  await url.fill("{{visual-fixture-base}}/draft");
  const identity = await raw.elementHandle();
  await trigger.press("Enter");
  await menu.waitFor();
  await choices.first().press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await identity.evaluate((el) => el.isConnected), true);
  assert.equal(await raw.inputValue(), draft);
  await trigger.press("ArrowUp");
  await menu.waitFor();
  await menuItem("提取变量").press("Enter");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await tab("extract").getAttribute("aria-pressed"), "true");
  assert.equal(await assertFull("extract"), true);
  await trigger.press("Enter");
  await menu.waitFor();
  await menuItem("Body (1)").press("Enter");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await raw.inputValue(), draft);
  assert.equal(await url.inputValue(), "{{visual-fixture-base}}/draft");
  assert.equal(await assertFull("body"), true);

  await trigger.press("Enter");
  await menu.waitFor();
  await page.setViewportSize({ width: 430, height: 830 });
  await trigger.waitFor({ state: "hidden" });
  await menu.waitFor({ state: "hidden" });
  assert.equal(await strip.locator("[data-param]").count(), 11);
  assert.equal(await active(tab("body")), true);
  assert.equal(await raw.inputValue(), draft);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("response-layout")),
    "split",
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await capture("narrow-stacked");
  assert.deepEqual(await app.store.get(owner.id), baseline);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "HTTP_REQUEST_PARAMETER_OVERFLOW_UI_PASS clipped both edges, focus, no execute or project writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(home, { recursive: true, force: true });
}
