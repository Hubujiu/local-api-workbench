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
const root = await mkdtemp(join(tmpdir(), "appearance-font-scale-ui-"));
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const fixture = await app.store.create("默认项目");
  fixture.requests.push(
    normalizeRequest({
      id: "font-visual",
      name: "Trash Visual Fixture",
      method: "POST",
      url: "http://127.0.0.1:1/font-visual",
      bodyType: "json",
      body: '{\n  "font": "fixture",\n  "persisted": false\n}',
    }),
  );
  await app.store.save(fixture);
  const baseline = await app.store.get(fixture.id);
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
  const scale = modal.getByRole("spinbutton", {
    name: "字体缩放",
    exact: true,
  });
  const up = modal.getByRole("button", { name: "增大字体", exact: true });
  const down = modal.getByRole("button", { name: "减小字体", exact: true });
  const close = modal.getByRole("button", {
    name: "关闭外观设置",
    exact: true,
  });
  const reset = modal.getByRole("button", {
    name: "恢复默认外观",
    exact: true,
  });
  const bodyTab = page.locator('.param-tabs [data-param="body"]');
  const focus = (locator) =>
    locator.evaluate((node) => node === document.activeElement);
  const prefix = process.env.APPEARANCE_SCALE_CAPTURE_PREFIX;
  const capture = async (state, narrow = false) => {
    if (!prefix) return;
    await page.mouse.move(narrow ? 415 : 1320, 102);
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
  const fonts = () =>
    page.evaluate(() =>
      [
        "html",
        "#request-name",
        "#body-code",
        "#code-highlight",
        "#code-gutter",
        ".param-tabs [data-param='body']",
      ].map((selector) => {
        const { fontSize, lineHeight } = getComputedStyle(
          document.querySelector(selector),
        );
        return { fontSize, lineHeight };
      }),
    );
  const stored = () =>
    page.evaluate(() => localStorage.getItem("appearance-font-scale"));
  const panelGeometry = async () => ({
    dialog: await geometry(modal),
    previews: [
      await geometry(modal.locator(".appearance-preview--light")),
      await geometry(modal.locator(".appearance-preview--dark")),
    ],
    control: await geometry(modal.locator(".appearance-font-scale-control")),
    arrows: await geometry(modal.locator(".appearance-font-scale-arrows")),
  });

  await bodyTab.click();
  metrics.normalFonts = await fonts();
  assert.deepEqual(metrics.normalFonts[0], {
    fontSize: "13px",
    lineHeight: "normal",
  });
  for (const editor of metrics.normalFonts.slice(2, 5))
    assert.deepEqual(editor, { fontSize: "12px", lineHeight: "16px" });
  await trigger.click();
  assert.equal(await focus(close), true);
  assert.equal(await scale.inputValue(), "100");
  assert.equal(await reset.isDisabled(), true);
  metrics.normal = await panelGeometry();
  console.log("Appearance typography geometry", JSON.stringify(metrics.normal));
  await capture("100");
  assert.deepEqual(metrics.normal.dialog, {
    x: 242,
    y: 212,
    width: 880,
    height: 600,
  });
  assert.deepEqual(metrics.normal.control, {
    x: 1002,
    y: 413,
    width: 90,
    height: 32,
  });
  assert.equal(metrics.normal.arrows.width, 22);

  await up.click();
  assert.equal(await scale.inputValue(), "110");
  assert.equal(await stored(), "110");
  assert.equal(await reset.isEnabled(), true);
  metrics.large = await panelGeometry();
  assert.deepEqual(metrics.large, metrics.normal);
  metrics.largeFonts = await fonts();
  for (const i of [0, 1, 2, 3, 4, 5])
    assert.ok(
      Math.abs(
        parseFloat(metrics.largeFonts[i].fontSize) -
          1.1 * parseFloat(metrics.normalFonts[i].fontSize),
      ) < 0.001,
    );
  for (const editor of metrics.largeFonts.slice(2, 5))
    assert.deepEqual(editor, { fontSize: "13.2px", lineHeight: "17.6px" });
  await capture("110");
  await down.click();
  assert.equal(await scale.inputValue(), "100");
  assert.deepEqual(await fonts(), metrics.normalFonts);

  await scale.press("ArrowUp");
  assert.equal(await scale.inputValue(), "110");
  await scale.fill("115");
  await scale.press("Enter");
  assert.equal(await scale.getAttribute("aria-invalid"), "true");
  assert.equal(await stored(), "110");
  assert.match(await modal.getByRole("status").textContent(), /80–120/);
  await scale.fill("120");
  await scale.press("Enter");
  assert.equal(await scale.getAttribute("aria-invalid"), null);
  assert.equal(await up.isDisabled(), true);
  assert.equal(await stored(), "120");
  await scale.press("ArrowUp");
  assert.equal(await scale.inputValue(), "120");
  await scale.press("ArrowDown");
  assert.equal(await scale.inputValue(), "110");
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  assert.equal(await focus(trigger), true);

  await page.reload();
  await bodyTab.click();
  assert.deepEqual(await fonts(), metrics.largeFonts);
  const name = page.locator("#request-name");
  const body = page.locator("#body-code");
  const draft = '{"font":"dirty fixture"}';
  await name.fill("未保存字体验证");
  await body.fill(draft);
  await trigger.click();
  assert.equal(await scale.inputValue(), "110");
  await scale.press("Control+s");
  await scale.press("Control+Enter");
  assert.equal(await modal.isVisible(), true);
  await scale.fill("80");
  await close.focus(); // Native change/blur commits a valid manually typed value.
  assert.equal(await stored(), "80");
  assert.equal(await down.isDisabled(), true);
  await reset.click();
  assert.equal(await scale.inputValue(), "100");
  assert.equal(await stored(), "100");
  assert.equal(await reset.isDisabled(), true);
  assert.deepEqual(await fonts(), metrics.normalFonts);
  await close.click();
  await modal.waitFor({ state: "hidden" });
  assert.equal(await name.inputValue(), "未保存字体验证");
  assert.equal(await body.inputValue(), draft);

  await page.setViewportSize({ width: 430, height: 760 });
  await trigger.click();
  metrics.narrow = await panelGeometry();
  assert.ok(metrics.narrow.dialog.x + metrics.narrow.dialog.width <= 430);
  assert.ok(metrics.narrow.control.x + metrics.narrow.control.width <= 430);
  await up.click();
  assert.equal(await scale.inputValue(), "110");
  await capture("narrow", true);
  await close.click();
  assert.equal(await body.inputValue(), draft);
  assert.match(await page.locator("#saved-state").textContent(), /未保存/);
  assert.deepEqual(await app.store.get(fixture.id), baseline);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  if (prefix)
    await writeFile(
      prefix + ".json",
      JSON.stringify({ metrics, blocked, errors }, null, 2) + "\n",
    );
  console.log(
    "APPEARANCE_FONT_SCALE_UI_PASS 90x32/80–120/100-baseline/110/no-geometry-zoom/keyboard/typed/reload/dirty/430/no-writes",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
