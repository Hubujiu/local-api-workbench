import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp("/tmp/workbench-doc-scroll-");
const app = await createApp({ root, port: 0 });
let browser;
try {
  const captures = process.env.WORKSPACE_DOCUMENT_SCROLL_SCREENSHOTS;
  const source = await readFile(
    new URL("./fixtures/document-scroll.md", import.meta.url),
    "utf8",
  );
  const project = await app.store.create("默认项目");
  project.requests = [
    normalizeRequest({
      id: "verification",
      name: "Verification",
      url: "http://127.0.0.1:38982/verification",
    }),
  ];
  project.documents = [
    { id: "scroll-intro", title: "项目说明", content: "# Intro" },
    { id: "scroll-primary", title: "Verification Notes", content: source },
  ];
  await app.store.save(project);
  const baseline = await app.store.get(project.id);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    // Playwright hides even styled scrollbars by default in headless Chrome.
    ignoreDefaultArgs: ["--hide-scrollbars"],
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const origin = new URL(app.launchUrl).origin;
  const forbidden = [],
    errors = [];
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    forbidden.push(request.method() + " " + url.pathname);
    return route.abort();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.goto(app.launchUrl);
  const primary = page.locator('[data-document-index="1"]');
  const work = page.getByRole("region", { name: "本地 Markdown 文档" });
  const edit = work.getByRole("button", { name: "编辑", exact: true });
  const editor = work.getByRole("textbox", { name: "Markdown 正文" });
  const preview = work.getByRole("article", { name: "文档预览" });
  const linked = work.getByRole("checkbox", { name: "同步滚动" });
  const top = work.getByRole("button", { name: "回到顶部" });
  const focusIs = (locator) =>
    locator.evaluate((element) => document.activeElement === element);
  await primary.press("Enter");
  await edit.press("Enter");
  assert(await linked.isChecked());
  assert.equal(await editor.inputValue(), source);
  const state = () =>
    page.evaluate(() => {
      const editor = document.querySelector("#workspace-document-text");
      const preview = document.querySelector("#workspace-document-preview");
      return [editor, preview].map((pane) => ({
        top: pane.scrollTop,
        max: pane.scrollHeight - pane.clientHeight,
        x: pane.scrollLeft,
      }));
    });
  const atTop = () =>
    page.waitForFunction(
      () =>
        document.getElementById("workspace-document-text")?.scrollTop === 0 &&
        document.getElementById("workspace-document-preview")?.scrollTop === 0,
    );
  const syncSettled = (min) =>
    page.waitForFunction((floor) => {
      const [editor, preview] = [
        "workspace-document-text",
        "workspace-document-preview",
      ].map((id) => document.getElementById(id));
      return (
        editor.scrollTop > floor &&
        preview.scrollTop > floor &&
        Math.abs(
          editor.scrollTop / (editor.scrollHeight - editor.clientHeight) -
            preview.scrollTop / (preview.scrollHeight - preview.clientHeight),
        ) < 0.001
      );
    }, min);
  const still = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const wheel = async (pane, amount) => {
    const box = await pane.boundingBox();
    assert(box && box.height > 0);
    await page.mouse.move(
      box.x + box.width / 2,
      box.y + Math.min(100, box.height / 2),
    );
    await page.mouse.wheel(0, amount);
  };
  const visualMetrics = await page.evaluate(() => {
    const footer = document.querySelector(".workspace-document-footer");
    const preview = document.querySelector("#workspace-document-preview");
    const h2 = preview.querySelector("h2");
    const frame = footer.closest(".workspace-document-editor");
    return {
      footerY: footer.getBoundingClientRect().y,
      frameBottom: frame.getBoundingClientRect().bottom,
      previewInk: getComputedStyle(preview).color,
      h2Rule: getComputedStyle(h2).borderBottomColor,
      h2RuleWidth: getComputedStyle(h2).borderBottomWidth,
    };
  });
  assert.deepEqual(visualMetrics, {
    footerY: 931,
    frameBottom: 958,
    previewInk: "rgb(96, 98, 102)",
    h2Rule: "rgb(220, 220, 226)",
    h2RuleWidth: "1px",
  });

  const assertCapturePixels = async (png) => {
    const pixels = await page.evaluate(async (encoded) => {
      const source = new Image();
      source.src = "data:image/png;base64," + encoded;
      await source.decode();
      const canvas = document.createElement("canvas");
      canvas.width = source.width;
      canvas.height = source.height;
      const context = canvas.getContext("2d");
      context.drawImage(source, 0, 0);
      const color = (x, y) =>
        [...context.getImageData(x, y, 1, 1).data.slice(0, 3)].join(",");
      const find = (x, target, range) =>
        range
          .map((y) => (color(x, y) === target ? y : null))
          .filter((y) => y !== null);
      const rule = "220,220,226";
      const thumb = "235,224,203";
      const thumbPixels = (x0, x1) => {
        let count = 0;
        for (let x = x0; x <= x1; x++)
          count += find(
            x,
            thumb,
            Array.from({ length: 92 }, (_, i) => 210 + i),
          ).length;
        return count;
      };
      return {
        footer: color(722, 931),
        rules: [264, 322, 478].map((target) =>
          find(
            1190,
            rule,
            Array.from({ length: 7 }, (_, i) => target + i - 3),
          ),
        ),
        editorThumb: thumbPixels(850, 858),
        previewThumb: thumbPixels(1338, 1345),
      };
    }, png.toString("base64"));
    assert.equal(pixels.footer, "232,229,223", JSON.stringify(pixels));
    assert(
      pixels.rules.every((rule) => rule.length === 1),
      JSON.stringify(pixels),
    );
    assert(
      pixels.editorThumb > 45 && pixels.previewThumb > 45,
      JSON.stringify(pixels),
    );
    return pixels;
  };
  const capture = async (name) => {
    if (captures)
      return page.screenshot({
        path: join(captures, "docs-scroll-workbench-" + name + ".png"),
        clip: { x: 0, y: 0, width: 1363, height: 980 },
        caret: "hide",
        animations: "disabled",
      });
  };
  await atTop();
  await editor.blur();
  await editor.evaluate((pane) => pane.setSelectionRange(10, 30));
  await capture("top");
  await wheel(editor, 385);
  await syncSettled(200);
  await still();
  const synchronized = await state();
  assert.deepEqual(await state(), synchronized);
  await capture("on");

  await linked.press("Space");
  assert.equal(await linked.isChecked(), false);
  assert.deepEqual(
    await state(),
    synchronized,
    "opting out does not move either pane",
  );
  await wheel(editor, 550);
  await page.waitForFunction(
    (before) =>
      document.getElementById("workspace-document-text").scrollTop >
      before + 200,
    synchronized[0].top,
  );
  await still();
  const independent = await state();
  assert.equal(independent[1].top, synchronized[1].top);
  await capture("off");
  await top.press("Enter");
  await atTop();
  assert(await focusIs(top));
  assert.equal(await linked.isChecked(), false);
  const topOffCapture = await capture("top-off");
  const capturedPixels =
    topOffCapture && (await assertCapturePixels(topOffCapture));

  await linked.press("Space");
  await wheel(preview, 320);
  await syncSettled(200);
  await still();
  const reverse = await state();
  await capture("preview-on");
  await wheel(preview, 60000);
  await page.waitForFunction(() =>
    ["workspace-document-text", "workspace-document-preview"].every((id) => {
      const pane = document.getElementById(id);
      return (
        Math.abs(pane.scrollHeight - pane.clientHeight - pane.scrollTop) <= 1
      );
    }),
  );
  const end = await state();
  await still();
  assert.deepEqual(await state(), end, "bottom cap does not oscillate");
  assert.deepEqual(
    await editor.evaluate((pane) => [pane.selectionStart, pane.selectionEnd]),
    [10, 30],
  );

  await page.setViewportSize({ width: 430, height: 770 });
  await top.press("Enter");
  await atTop();
  assert(await focusIs(top));
  assert.deepEqual(
    await page.evaluate(() => {
      const { clientWidth, scrollWidth } = document.documentElement;
      return [window.innerWidth, scrollWidth - clientWidth];
    }),
    [430, 0],
    "a classic vertical scrollbar may reduce the usable width, but not create horizontal overflow",
  );
  await preview.press("PageDown");
  await syncSettled(20);
  assert(await focusIs(preview));
  await linked.press("Space");
  assert.equal(await linked.isChecked(), false);
  const narrowIndependent = await state();
  await preview.press("PageDown");
  await page.waitForFunction(
    (before) =>
      document.getElementById("workspace-document-preview").scrollTop > before,
    narrowIndependent[1].top,
  );
  await still();
  assert.equal((await state())[0].top, narrowIndependent[0].top);
  await top.press("Enter");
  await atTop();
  assert(await focusIs(top));
  await work.getByRole("button", { name: "预览", exact: true }).press("Enter");
  assert.equal(await linked.count(), 0);
  await edit.press("Enter");
  assert.equal(
    await linked.isChecked(),
    false,
    "opt-out belongs to the active document for the current open project",
  );
  assert.equal(await editor.inputValue(), source);
  await page.setViewportSize({ width: 1363, height: 1023 });
  await page.locator('[data-document-index="0"]').press("Enter");
  await edit.press("Enter");
  assert(await linked.isChecked(), "another document remains default-linked");
  await page
    .locator('[data-open-document-tab="scroll-primary"]')
    .press("Enter");
  assert.equal(await linked.isChecked(), false);
  assert.equal(await editor.inputValue(), source);
  assert.deepEqual(await app.store.get(project.id), baseline);
  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      visualMetrics,
      capturedPixels,
      synchronized,
      independent,
      reverse,
      end,
      writes: 0,
      forbidden,
      errors,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
