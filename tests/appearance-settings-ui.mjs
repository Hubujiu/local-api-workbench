import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "appearance-settings-ui-"));
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("默认项目");
  for (const r of [
    {
      id: "trash-visual-fixture",
      name: "Trash Visual Fixture",
      method: "POST",
      bodyType: "json",
      body: '{"fixture":"synthetic"}',
    },
    { id: "verification", name: "Verification", method: "GET" },
  ]) {
    project.requests.push(
      normalizeRequest({
        ...r,
        url: "http://127.0.0.1:1/" + r.id,
      }),
    );
  }
  await app.store.save(project);
  const baseline = await app.store.get(project.id);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  page.setDefaultTimeout(7500);
  const origin = new URL(app.launchUrl).origin;
  const blocked = [],
    errors = [],
    metrics = {};
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (req.method() === "GET" && url.origin === origin)
      return route.continue();
    blocked.push([req.method(), url.pathname]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const trigger = page.getByRole("button", {
    name: "全局外观设置",
    exact: true,
  });
  const modal = page.getByRole("dialog", { name: "应用设置", exact: true });
  const close = modal.getByRole("button", {
    name: "关闭外观设置",
    exact: true,
  });
  const reset = modal.getByRole("button", {
    name: "恢复默认外观",
    exact: true,
  });
  const light = modal.getByRole("radio", { name: "浅色", exact: true });
  const dark = modal.getByRole("radio", { name: "深色", exact: true });
  const isDark = () => page.locator("body.dark").count();
  const focus = (target) =>
    target.evaluate((node) => node === document.activeElement);
  const stored = () => page.evaluate(() => localStorage.getItem("theme"));
  const prefix = process.env.APPEARANCE_CAPTURE_PREFIX;
  const capture = async (state, narrow = false) => {
    if (!prefix) return;
    await page.mouse.move(narrow ? 417 : 1310, 126);
    await page.screenshot({
      path: prefix + "-" + state + ".png",
      animations: "disabled",
      caret: "hide",
      ...(narrow ? {} : { clip: { x: 0, y: 0, width: 1363, height: 965 } }),
    });
  };
  const geometry = async (locator) => {
    const values = await locator.boundingBox();
    assert.ok(values);
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, Math.round(value)]),
    );
  };

  await page.locator('.rail [data-page="history"]').click();
  await trigger.click();
  await modal.waitFor();
  assert.equal(await focus(close), true);
  assert.equal(await light.isChecked(), true);
  assert.equal(await reset.isDisabled(), true);
  metrics.dialog = await geometry(modal);
  metrics.sidebar = await geometry(modal.locator(".appearance-sidebar"));
  metrics.light = await geometry(modal.locator(".appearance-preview--light"));
  metrics.dark = await geometry(modal.locator(".appearance-preview--dark"));
  console.log("Appearance geometry", JSON.stringify(metrics));
  await capture("light");
  assert.deepEqual(metrics.dialog, { x: 242, y: 212, width: 880, height: 600 });
  assert.equal(metrics.sidebar.width, 200);
  assert.deepEqual(metrics.light, { x: 952, y: 309, width: 60, height: 40 });
  assert.deepEqual(metrics.dark, { x: 1032, y: 309, width: 60, height: 40 });

  await light.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await dark.isChecked(), true);
  assert.equal(await isDark(), 1);
  assert.equal(await stored(), "dark");
  await capture("dark");
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+Enter");
  assert.equal(await modal.isVisible(), true);
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  assert.equal(await focus(trigger), true);
  await capture("dark-workspace");
  await page.reload();
  await trigger.waitFor();
  assert.equal(await isDark(), 1);
  await trigger.click();
  assert.equal(await dark.isChecked(), true);
  await reset.click();
  assert.equal(await light.isChecked(), true);
  assert.equal(await focus(light), true);
  assert.equal(await reset.isDisabled(), true);
  assert.equal(await isDark(), 0);
  assert.equal(await stored(), "light");
  await close.click();
  await modal.waitFor({ state: "hidden" });
  assert.equal(await focus(trigger), true);

  await page.locator('.rail [data-page="apis"]').click();
  const name = page.locator("#request-name");
  await name.fill("当前未保存接口");
  await page.locator('[data-param="body"]').click();
  const body = page.locator("#body-code");
  const draft = '{"fixture":"edited, not saved"}';
  await body.fill(draft);
  const helper = page.locator("#toggle-parameter-helper");
  await helper.click();
  assert.equal(await helper.getAttribute("aria-expanded"), "true");
  await trigger.click();
  await dark.click();
  assert.equal(await isDark(), 1);
  assert.equal(await modal.isVisible(), true);
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  assert.equal(await focus(trigger), true);
  assert.equal(await name.inputValue(), "当前未保存接口");
  assert.equal(await body.inputValue(), draft);
  assert.match(await page.locator("#saved-state").textContent(), /未保存/);
  await page.locator("#theme").click();
  assert.equal(await isDark(), 0);
  assert.equal(await stored(), "light");
  assert.equal(await body.inputValue(), draft);

  await page.setViewportSize({ width: 430, height: 760 });
  await trigger.click();
  metrics.narrow = await geometry(modal);
  assert.ok(
    metrics.narrow.x >= 0 && metrics.narrow.x + metrics.narrow.width <= 430,
  );
  assert.ok(
    metrics.narrow.y >= 0 && metrics.narrow.y + metrics.narrow.height <= 760,
  );
  const narrowChoice = await geometry(
    modal.locator(".appearance-preview--dark"),
  );
  assert.ok(narrowChoice.x + narrowChoice.width <= 430);
  await dark.click();
  assert.equal(await isDark(), 1);
  await capture("narrow", true);
  await close.click();
  await modal.waitFor({ state: "hidden" });
  assert.equal(await focus(trigger), true);
  assert.equal(await body.inputValue(), draft);
  assert.deepEqual(await app.store.get(project.id), baseline);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  if (prefix)
    await writeFile(
      prefix + ".json",
      JSON.stringify({ metrics, blocked, errors }, null, 2) + "\n",
    );
  console.log(
    "APPEARANCE_SETTINGS_UI_PASS 880x600/preview/keyboard/dark-refresh/reset/dirty-raw-helper/430/zero-writes",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
