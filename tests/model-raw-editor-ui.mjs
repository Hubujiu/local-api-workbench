import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.MODEL_RAW_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-model-raw-editor-"));
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const owner = await app.store.create("默认项目");
  const baseline = await app.store.get(owner.id);
  const origin = new URL(app.launchUrl).origin;
  const blocked = [],
    errors = [];
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  page.setDefaultTimeout(8500);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("theme", "light");
    window.__modelRawCSP = [];
    window.__modelRawCSPStage = "navigate";
    window.addEventListener("securitypolicyviolation", (event) => {
      const target = event.target;
      window.__modelRawCSP.push({
        stage: window.__modelRawCSPStage,
        directive: event.effectiveDirective,
        disposition: event.disposition,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        line: event.lineNumber,
        column: event.columnNumber,
        target:
          target instanceof Element
            ? { tag: target.localName, id: target.id, class: target.className }
            : null,
      });
    });
  });
  await page.route("**/*", (route) => {
    const req = route.request();
    if (req.method() === "GET" && new URL(req.url()).origin === origin)
      return route.continue();
    blocked.push([req.method(), new URL(req.url()).pathname]);
    return route.abort();
  });

  const cspStage = (stage) =>
    page.evaluate((value) => {
      window.__modelRawCSPStage = value;
    }, stage);
  await page.goto(app.launchUrl);
  await cspStage("open-new-draft");
  await page.locator('.rail [data-page="dictionary"]').press("Enter");
  const menu = page.locator(".dictionary-model-create");
  await menu.locator(":scope > summary").press("Enter");
  await menu.getByRole("button", { name: "新建数据模型" }).press("Enter");
  const draft = page.getByRole("region", { name: "数据模型草稿" });
  const openRaw = draft.getByRole("button", { name: "Raw编辑" });
  const dialog = page.getByRole("dialog", { name: "Raw", exact: true });
  const raw = dialog.getByRole("textbox", { name: "模型 Schema JSON" });
  const layers = dialog.locator(".model-workspace-raw");
  const ink = layers.locator("[data-model-raw-ink]");
  const gutter = layers.locator("[data-model-raw-lines]");
  const apply = dialog.getByRole("button", { name: "应用到模型草稿" });
  const active = (locator) =>
    locator.evaluate((el) => el === document.activeElement);
  const near = (actual, expected, delta, name) =>
    assert(
      Math.abs(actual - expected) <= delta,
      `${name}: ${actual} expected ${expected} ± ${delta}`,
    );
  const waitPlain = () => ink.waitFor({ state: "hidden" });
  const waitInk = () => ink.waitFor({ state: "visible" });
  const capture = async (name) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, "model-raw-" + name + ".png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  };
  await cspStage("open-raw");
  await openRaw.press("Enter");
  assert(await active(raw));
  await waitInk();
  assert.deepEqual(JSON.parse(await raw.inputValue()), {
    type: "object",
    properties: {},
  });
  assert.equal(await gutter.textContent(), "1\n2\n3\n4");
  assert.equal(await ink.locator(".syntax-key").count(), 2);
  assert.equal(await layers.locator("textarea").count(), 1);
  assert.equal(await layers.locator("[contenteditable]").count(), 0);
  assert.equal(await ink.getAttribute("aria-hidden"), "true");
  const boxes = Object.fromEntries(
    await Promise.all(
      [
        ["dialog", dialog],
        ["header", dialog.locator("header")],
        ["editor", layers],
        ["gutter", gutter],
        ["field", raw],
      ].map(async ([name, element]) => [name, await element.boundingBox()]),
    ),
  );
  console.log("MODEL_RAW_BOXES", JSON.stringify(boxes));
  assert.equal(boxes.header.height, 56);
  near(boxes.dialog.x, 242, 2, "dialog left");
  near(boxes.dialog.y, 252, 5, "dialog top");
  near(boxes.editor.x, 261, 3, "editor left");
  near(boxes.editor.y, 310, 5, "editor top");
  near(boxes.field.x - boxes.editor.x, 62, 1, "gutter width");
  assert.deepEqual(
    await layers
      .locator("textarea, pre")
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).lineHeight),
      ),
    ["16px", "16px", "16px"],
  );
  boxes.firstRow = await layers.evaluate((editor) => {
    const firstGlyph = (selector) => {
      const text = editor.querySelector(selector).firstChild;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 1);
      const { x, y } = range.getBoundingClientRect();
      return { x, y };
    };
    return {
      ink: firstGlyph("[data-model-raw-ink]"),
      gutter: firstGlyph("[data-model-raw-lines]"),
      focusOutline: getComputedStyle(editor).outlineStyle,
      fieldPadding: getComputedStyle(editor.querySelector("textarea")).padding,
    };
  });
  near(boxes.firstRow.ink.x, boxes.field.x, 1, "first code glyph origin");
  near(boxes.firstRow.ink.y, boxes.editor.y, 2, "first code glyph top");
  near(
    boxes.firstRow.gutter.y,
    boxes.firstRow.ink.y,
    1,
    "aligned gutter first row",
  );
  assert.equal(boxes.firstRow.focusOutline, "solid");
  assert.equal(boxes.firstRow.fieldPadding, "0px");
  // Simulate compact and tall host fonts without requiring those faces to be
  // installed. The different computed line boxes are the actual test input.
  const fontContexts = await dialog.locator("header").evaluate((header) => {
    const controls = [...header.children];
    const editor = header.parentNode.querySelector(".model-workspace-raw");
    return [
      ["monospace", 18],
      ["serif", 40],
    ].map(([family, pitch]) => {
      try {
        for (const control of controls) {
          control.style.fontFamily = family;
          control.style.lineHeight = pitch + "px";
        }
        const { top, bottom, height } = header.getBoundingClientRect();
        return {
          editorY: editor.getBoundingClientRect().y,
          headerHeight: height,
          controlMetrics: controls.map((control) => {
            const style = getComputedStyle(control);
            const rect = control.getBoundingClientRect();
            return {
              font: style.fontFamily,
              pitch: style.lineHeight,
              contained: rect.top >= top && rect.bottom <= bottom,
              centered:
                Math.abs((rect.top + rect.bottom - top - bottom) / 2) <= 1,
            };
          }),
        };
      } finally {
        for (const control of controls) {
          control.style.removeProperty("font-family");
          control.style.removeProperty("line-height");
        }
      }
    });
  });
  console.log("MODEL_RAW_FONT_CONTEXTS", JSON.stringify(fontContexts));
  for (const [index, font] of fontContexts.entries()) {
    assert.equal(font.headerHeight, 56);
    near(font.editorY, boxes.editor.y, 0.25, "font-independent editor top");
    for (const control of font.controlMetrics) {
      assert.equal(control.font, index ? "serif" : "monospace");
      assert.equal(control.pitch, index ? "40px" : "18px");
      assert(control.contained && control.centered);
    }
  }
  await cspStage("capture");
  await capture("uncommitted");
  await cspStage("edit-and-cancel");

  const scrollRanges = () =>
    raw.evaluate((field) => {
      const content = field.closest("#dialog-content");
      return [
        content.scrollWidth - content.clientWidth,
        content.scrollHeight - content.clientHeight,
        field.scrollWidth - field.clientWidth,
        field.scrollHeight - field.clientHeight,
      ];
    });
  assert.deepEqual(await scrollRanges(), [0, 0, 0, 0]);
  await page.setViewportSize({ width: 1364, height: 960 });
  assert.deepEqual(await scrollRanges(), [0, 0, 0, 0]);
  assert(await apply.isVisible());
  await page.setViewportSize({ width: 1363, height: 1023 });

  const partial = '\n{\n\t"description": "<plain> 中文 & literal",\n';
  await raw.fill(partial);
  await page.waitForFunction(
    (value) =>
      document.querySelector("[data-model-raw-ink]")?.textContent ===
      value + "\n",
    partial,
  );
  assert.equal(await raw.inputValue(), partial);
  assert.equal(
    await ink.locator("span.syntax-string").textContent(),
    '"<plain> 中文 & literal"',
  );
  await raw.evaluate((el) => {
    el.setSelectionRange(3, 7, "backward");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.deepEqual(
    await raw.evaluate((el) => [
      el.selectionStart,
      el.selectionEnd,
      el.selectionDirection,
    ]),
    [3, 7, "backward"],
  );
  await raw.evaluate((el) =>
    el.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    ),
  );
  await waitPlain();
  assert(await active(raw));
  assert.equal(await raw.inputValue(), partial);
  await raw.evaluate((el) =>
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
  );
  await waitInk();
  assert.deepEqual(
    await raw.evaluate((el) => [el.selectionStart, el.selectionEnd]),
    [3, 7],
  );

  const tallWide = JSON.stringify(
    {
      type: "object",
      description: "Wide ".repeat(500),
      examples: Array.from({ length: 100 }, (_, i) => ({ n: i })),
    },
    null,
    2,
  );
  await raw.fill(tallWide);
  await raw.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.scrollLeft = el.scrollWidth;
  });
  await page.waitForFunction(() => {
    const field = document.querySelector("#model-workspace-json");
    const mirrored = new DOMMatrix(
      getComputedStyle(
        document.querySelector("[data-model-raw-ink]"),
      ).transform,
    );
    const rail = new DOMMatrix(
      getComputedStyle(
        document.querySelector("[data-model-raw-lines]"),
      ).transform,
    );
    return (
      field.scrollTop > 50 &&
      field.scrollLeft > 50 &&
      mirrored.m41 === -field.scrollLeft &&
      mirrored.m42 === -field.scrollTop &&
      rail.m42 === -field.scrollTop
    );
  });
  assert.equal(await raw.inputValue(), tallWide);
  const [outerX, outerY, inputX, inputY] = await scrollRanges();
  assert.deepEqual([outerX, outerY], [0, 0]);
  assert(inputX > 50 && inputY > 50);
  assert(await apply.isVisible());
  await page.emulateMedia({ forcedColors: "active" });
  await waitPlain();
  assert.notEqual(
    await raw.evaluate((el) => getComputedStyle(el).color),
    "rgba(0, 0, 0, 0)",
  );
  assert.equal(await raw.inputValue(), tallWide);
  await page.emulateMedia({ forcedColors: "none" });
  await waitInk();

  const oversized = " ".repeat(65537) + "false";
  await raw.fill(oversized);
  await waitPlain();
  assert.equal(await raw.inputValue(), oversized);
  await raw.fill("{");
  await apply.press("Enter");
  assert(await dialog.isVisible());
  assert(await page.locator("#toast").isVisible());
  assert(await apply.isVisible());
  assert.equal(await raw.inputValue(), "{");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert(await active(openRaw));

  await openRaw.press("Enter");
  assert.deepEqual(JSON.parse(await raw.inputValue()), {
    type: "object",
    properties: {},
  });
  await cspStage("apply-valid-model-schema");
  await raw.fill(
    '{"type":"array","items":{"type":"string"},"description":"模型"}',
  );
  await apply.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  assert(await active(openRaw));
  await page.setViewportSize({ width: 430, height: 720 });
  await openRaw.press("Enter");
  const narrow = await dialog.boundingBox();
  assert(narrow.x >= 0 && narrow.x + narrow.width <= 430);
  assert.equal(JSON.parse(await raw.inputValue()).description, "模型");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert(await active(openRaw));
  assert.deepEqual(await app.store.get(owner.id), baseline);
  assert.deepEqual(await page.evaluate(() => window.__modelRawCSP), []);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  if (evidence)
    await writeFile(
      join(evidence, "model-raw-metrics.json"),
      JSON.stringify(boxes, null, 2) + "\n",
    );
  console.log(
    "MODEL_RAW_EDITOR_UI_PASS geometry/selection/composition/two-axis/csp/plain/cancel/no-writes",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
