import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const root = await mkdtemp(join(tmpdir(), "workbench-debug-raw-body-"));
const original = '{"message":"local synthetic draft","enabled":true,"count":2}';
const formatted = [
  "{",
  '  "message": "local synthetic draft",',
  '  "enabled": true,',
  '  "count": 2',
  "}",
].join("\n");
const invalid = '{"message":}';
const near = (found, expected, delta, name) =>
  assert(
    Math.abs(found - expected) <= delta,
    `${name}: ${found} expected ${expected} ± ${delta}`,
  );
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("默认项目");
  const request = normalizeRequest({
    id: "verification",
    name: "Verification",
    url: "http://127.0.0.1:38982/verification",
    bodyType: "json",
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
  await page.addInitScript(() => {
    localStorage.setItem("theme", "light");
    window.__bodyCopyEvents = [];
    document.addEventListener("copy", (event) => {
      const source = document.activeElement;
      window.__bodyCopyEvents.push(
        source?.id === "body-code"
          ? source.value.slice(source.selectionStart, source.selectionEnd)
          : source?.id,
      );
      // Exercise the native keyboard event without touching the host clipboard.
      event.preventDefault();
    });
  });
  await page.route("**/*", (route) => {
    const req = route.request();
    if (req.method() === "GET" && new URL(req.url()).origin === origin)
      return route.continue();
    blocked.push([req.method(), new URL(req.url()).origin === origin]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const editor = page.locator('.editor[data-editor-mode="debug"]');
  const bodyTab = editor.locator('.param-tabs [data-param="body"]');
  await bodyTab.click();
  const body = editor.locator("#body-code");
  const gutter = editor.locator("#code-gutter");
  const format = editor.getByRole("button", {
    name: "格式化 JSON",
    exact: true,
    includeHidden: true,
  });
  const generate = editor.getByRole("button", {
    name: "基于数据结构生成",
    exact: true,
  });
  const expand = editor.locator("#expand-body");
  const rawFormat = editor.getByRole("combobox", { name: "Raw格式" });
  const actions = editor.locator(".http-debug-raw-actions");
  const prefix = process.env.HTTP_DEBUG_RAW_CAPTURE_PREFIX;
  const measurements = {};
  async function capture(state) {
    if (!prefix) return;
    await page.mouse.move(800, 87);
    await page.evaluate(async () => {
      document.activeElement?.blur();
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await page.screenshot({
      path: `${prefix}-${state}.png`,
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  }
  assert.equal(await rawFormat.inputValue(), "json");
  assert.equal(await body.inputValue(), "");
  assert.equal(await gutter.textContent(), "1");
  assert(await generate.isVisible());
  assert.equal(await format.isVisible(), false);
  const toolbar = await actions.boundingBox();
  const code = await body.boundingBox();
  const leftGutter = await gutter.boundingBox();
  const expandBox = await expand.boundingBox();
  const helper = await editor.locator("#toggle-parameter-helper").boundingBox();
  const mode = await rawFormat.boundingBox();
  Object.assign(measurements, {
    toolbar,
    code,
    leftGutter,
    expandBox,
    helper,
    mode,
  });
  near(toolbar.x, 371, 1, "toolbar left");
  near(toolbar.y, 273, 2, "toolbar top");
  near(toolbar.height, 42, 1, "toolbar height");
  near(code.x, 433, 2, "editor text start");
  near(code.y, 315, 2, "editor top");
  near(leftGutter.width, 62, 1, "gutter span");
  near(helper.x, 1305, 3, "helper start");
  near(expandBox.x + expandBox.width / 2, 1280, 5, "expand center x");
  near(expandBox.y + expandBox.height / 2, 327, 4, "expand center y");
  near(mode.x, 864, 4, "Raw format control left");
  assert.deepEqual(
    await editor
      .locator("#body-code, #code-highlight, #code-gutter")
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).lineHeight),
      ),
    ["16px", "16px", "16px"],
  );
  await capture("empty");

  await body.focus();
  await page.keyboard.insertText(original);
  assert.equal(await body.inputValue(), original);
  assert(await format.isVisible());
  const polish = await format.boundingBox();
  measurements.format = polish;
  near(polish.x + polish.width / 2, 1230, 8, "beautify center");
  await capture("one-line");
  await format.press("Enter");
  assert.equal(await body.inputValue(), formatted);
  assert.equal(await detail(gutter), "1\n2\n3\n4\n5");
  assert(await format.evaluate((el) => el === document.activeElement));
  assert.deepEqual(await page.evaluate(() => window.__bodyCopyEvents), []);
  await capture("formatted");

  await body.fill(invalid);
  await format.press("Space");
  assert.equal(await body.inputValue(), invalid);
  assert.equal(await rawFormat.inputValue(), "json");
  await body.fill(formatted);
  await body.selectText();
  await page.keyboard.press("ControlOrMeta+c");
  assert.deepEqual(await page.evaluate(() => window.__bodyCopyEvents), [
    formatted,
  ]);
  assert.equal(await body.inputValue(), formatted);

  await expand.press("Enter");
  assert.equal(await expand.getAttribute("aria-pressed"), "true");
  assert(await body.evaluate((el) => el === document.activeElement));
  await page.keyboard.press("Escape");
  assert.equal(await expand.getAttribute("aria-pressed"), "false");
  assert(await expand.evaluate((el) => el === document.activeElement));
  assert.equal(await body.inputValue(), formatted);

  await rawFormat.selectOption("raw");
  assert.equal(await actions.count(), 0);
  const plain = 'not JSON — "local draft"';
  await body.fill(plain);
  assert.equal(await body.inputValue(), plain);
  await rawFormat.selectOption("json");
  assert.equal(await body.inputValue(), plain);
  await body.fill(original);
  await page.setViewportSize({ width: 430, height: 760 });
  const compactToolbar = await actions.boundingBox();
  const surfaceWidth = await page.evaluate(
    () => document.documentElement.clientWidth,
  );
  for (const control of [generate, format, expand]) {
    const box = await control.boundingBox();
    assert(
      box && box.x >= compactToolbar.x && box.x + box.width <= surfaceWidth + 1,
      JSON.stringify(box),
    );
  }
  await format.press("Enter");
  assert.equal(await body.inputValue(), formatted);

  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(await app.store.get(project.id), baseline);
  if (prefix)
    await writeFile(
      prefix + ".json",
      JSON.stringify(measurements, null, 2) + "\n",
    );
  console.log(
    "HTTP_DEBUG_BODY_RAW_UI_PASS geometry/beautify/invalid/copy/expand/narrow/no-dispatch",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

async function detail(gutter) {
  return (await gutter.textContent()).trim();
}
