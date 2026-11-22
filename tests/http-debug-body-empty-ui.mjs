import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const root = await mkdtemp(join(tmpdir(), "workbench-debug-empty-body-"));
const types = ["none", "form-data", "urlencoded", "binary", "msgpack", "raw"];
const draft = '{"draft":"retained across the empty view"}';
const near = (actual, expected, tolerance, label) =>
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual}, expected ${expected} ± ${tolerance}`,
  );
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("默认项目");
  const request = normalizeRequest({
    id: "verification",
    name: "Verification",
    url: "http://127.0.0.1:38982/verification",
    bodyType: "none",
  });
  project.requests.push(request);
  await app.store.save(project);
  const baseline = await app.store.get(project.id);
  const origin = new URL(app.launchUrl).origin;
  const blocked = [];
  const errors = [];
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    colorScheme: "light",
  });
  page.setDefaultTimeout(6500);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.route("**/*", (route) => {
    const req = route.request();
    if (req.method() === "GET" && new URL(req.url()).origin === origin)
      return route.continue();
    blocked.push([req.method(), new URL(req.url()).origin === origin]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const editor = page.locator('.editor[data-editor-mode="debug"]');
  const radio = (type) =>
    editor.locator(`input[name="body-type"][value="${type}"]`);
  const empty = editor.locator(".body-none");
  await editor.locator('.param-tabs [data-param="body"]').click();
  await empty.getByText("当前请求未包含 Body", { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const frame = await empty.boundingBox();
  assert.deepEqual(
    [frame.x, frame.y, frame.width, frame.height],
    [371, 273, 976, 140],
  );
  const radios = await editor
    .locator('input[name="body-type"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          value: node.value,
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
          width: box.width,
          outline: style.borderTopColor,
        };
      }),
    );
  assert.deepEqual(
    radios.map(({ value }) => value),
    types,
  );
  assert.equal(await radio("none").isChecked(), true);
  for (const [i, targetX] of [386, 451, 545, 648, 720, 810].entries()) {
    near(radios[i].x, targetX, 6, types[i] + " center x");
    near(radios[i].y, 249, 2, types[i] + " center y");
    assert.equal(radios[i].width, 13);
  }
  assert.notEqual(radios[0].outline, radios[1].outline);
  const icon = await empty.locator(".body-none-icon svg").boundingBox();
  const message = await empty.locator("p").boundingBox();
  const generate = empty.getByRole("button", {
    name: "基于数据结构生成",
    exact: true,
  });
  const action = await generate.boundingBox();
  near(icon.x + icon.width / 2, 859, 1, "icon center x");
  near(icon.y, 286, 1, "icon CSS box y (visible linework starts lower)");
  near(message.y, 356, 1, "message CSS box y");
  assert(message.y + message.height <= action.y);
  assert(action.y + action.height <= frame.y + frame.height);
  const prefix = process.env.HTTP_DEBUG_EMPTY_CAPTURE_PREFIX;
  if (prefix) {
    await page.mouse.move(800, 88);
    await page.evaluate(() => document.activeElement?.blur());
    await page.screenshot({
      path: prefix + ".png",
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
    await writeFile(
      prefix + ".json",
      JSON.stringify({ frame, radios, icon, message, action }, null, 2) + "\n",
    );
  }
  await page.keyboard.press("Tab");
  await radio("none").focus();
  assert.equal(
    await radio("none").evaluate((el) => getComputedStyle(el).outlineWidth),
    "2px",
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await generate.evaluate((el) => el === document.activeElement),
    true,
  );
  await radio("none").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await radio("form-data").isChecked(), true);
  assert.equal(
    await radio("form-data").evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("ArrowLeft");
  assert.equal(await radio("none").isChecked(), true);
  assert.equal(
    await radio("none").evaluate((el) => el === document.activeElement),
    true,
  );
  await page.emulateMedia({ forcedColors: "active" });
  assert.equal(
    await radio("none").evaluate((el) => getComputedStyle(el).appearance),
    "auto",
  );
  await page.emulateMedia({ forcedColors: "none" });
  await page.keyboard.press("ArrowLeft");
  assert.equal(await radio("raw").isChecked(), true);
  const bodyCode = editor.locator("#body-code");
  await bodyCode.fill(draft);
  assert.equal(
    await radio("raw").evaluate((el) => getComputedStyle(el).appearance),
    "auto",
  );
  await radio("none").check();
  assert.equal(await bodyCode.count(), 0);
  await radio("raw").check();
  assert.equal(await bodyCode.inputValue(), draft);
  await radio("none").check();
  await editor.locator('[data-mode="design"]').click();
  const design = page.locator('.editor[data-editor-mode="design"]');
  await design.locator('[data-design-parameter="body"]').click();
  const designRadio = design.locator('input[name="body-type"][value="none"]');
  assert.equal(await designRadio.isChecked(), true);
  assert.equal(
    await designRadio.evaluate((el) => getComputedStyle(el).appearance),
    "auto",
  );
  await design.locator('[data-mode="debug"]').click();
  await editor.locator('.param-tabs [data-param="body"]').click();
  await page.setViewportSize({ width: 540, height: 760 });
  assert(await generate.isVisible());
  assert.equal(
    await radio("none").evaluate((el) => getComputedStyle(el).appearance),
    "auto",
  );
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(await app.store.get(project.id), baseline);
  console.log(
    "HTTP_DEBUG_BODY_EMPTY_UI_PASS geometry/keyboard/forced-colors/raw/design/narrow/no-dispatch",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
