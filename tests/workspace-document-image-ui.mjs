import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp("/tmp/workbench-document-image-");
const app = await createApp({ root, port: 0 });
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
  "base64",
);
const original =
  "# Verification Notes\n\nLocal synthetic document.\n\n- Request: Verification\n- Status: draft";
let browser;
try {
  const project = await app.store.create("默认项目");
  project.requests = [
    normalizeRequest({
      id: "verification",
      name: "Verification",
      url: "http://127.0.0.1:38982/verification",
    }),
  ];
  project.documents = [
    { id: "image-fixture", title: "Verification Notes", content: original },
  ];
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
  const blocked = [],
    errors = [],
    snapshots = [];
  let allowSave = false;
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    if (
      allowSave &&
      url.origin === origin &&
      url.pathname === "/api/projects/" + project.id &&
      request.method() === "PUT"
    ) {
      allowSave = false;
      snapshots.push(request.postDataJSON());
      return route.continue();
    }
    blocked.push(request.method() + " " + url.pathname);
    return route.abort();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.launchUrl);
  const work = page.getByRole("region", { name: "本地 Markdown 文档" });
  const content = work.getByRole("textbox", { name: "Markdown 正文" });
  const view = work.getByRole("article", { name: "文档预览" });
  const open = work.getByRole("button", { name: "插入本地图片" });
  const file = page.locator("#workspace-document-image-file");
  const ownTab = page.locator('[data-open-document-tab="image-fixture"]');
  const focusIs = (locator) =>
    locator.evaluate((element) => document.activeElement === element);
  const choose = async (files) => {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      open.press("Enter"),
    ]);
    assert.equal(chooser.isMultiple(), false);
    assert.equal(
      await chooser.element().getAttribute("accept"),
      "image/png,image/jpeg",
    );
    await chooser.setFiles(files);
  };
  await page.locator('[data-document-index="0"]').press("Enter");
  await work.getByRole("button", { name: "编辑", exact: true }).press("Enter");
  const box = await open.boundingBox();
  const toolbar = await work
    .getByRole("group", { name: "文档格式工具" })
    .boundingBox();
  const link = await work.getByRole("button", { name: "链接" }).boundingBox();
  assert.deepEqual(
    [
      box.x + box.width / 2,
      box.x - link.x,
      box.y - toolbar.y,
      box.width,
      box.height,
    ],
    [582, 36, 0, 36, 32],
  );
  // The separate 1363px capture gate checks the toolbar's absolute y193
  // against the installed reference, with the same browser/font setup.

  assert(await file.isHidden());
  await choose([]); // Real browser chooser, canceled without selecting a path.
  assert(await focusIs(open));
  assert.equal(await content.inputValue(), original);
  assert.deepEqual(snapshots, []);

  await choose({
    name: "malformed.png",
    mimeType: "image/png",
    buffer: Buffer.from("not a PNG"),
  });
  await page.getByText("PNG文件头无效", { exact: true }).waitFor();
  assert.equal(await content.inputValue(), original);
  await choose({
    name: "oversized.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(128 * 1024 + 1),
  });
  await page.getByText("图片最多128KiB", { exact: true }).waitFor();
  assert.equal(await content.inputValue(), original);
  const badDecode = Buffer.from(png.subarray(0, 33));
  await choose({
    name: "broken.png",
    mimeType: "image/png",
    buffer: badDecode,
  });
  await page.getByText("图片内容无法解码", { exact: true }).waitFor();
  assert.equal(await content.inputValue(), original);

  // Pause the genuine decoder, leave the document, and then complete the old
  // operation. It cannot modify the replacement editor even if the ID matches.
  await page.evaluate(() => {
    const originalDecode = createImageBitmap;
    window.createImageBitmap = async (...args) => {
      await new Promise((resolve) => {
        window.releaseImageFixture = resolve;
      });
      const bitmap = await originalDecode(...args);
      window.imageFixtureDone = true;
      return bitmap;
    };
    window.restoreImageFixture = () => {
      window.createImageBitmap = originalDecode;
    };
  });
  await choose({ name: "pending.png", mimeType: "image/png", buffer: png });
  await page.waitForFunction(
    () => typeof window.releaseImageFixture === "function",
  );
  await page.locator('[data-open-tab="verification"]').press("Enter");
  await ownTab.press("Enter");
  await page.evaluate(() => window.releaseImageFixture());
  await page.waitForFunction(() => window.imageFixtureDone);
  await page.evaluate(() => window.restoreImageFixture());
  assert.equal(await content.inputValue(), original);
  assert.equal(await view.locator("img").count(), 0);

  const highlighted = "Local synthetic document.";
  const start = original.indexOf(highlighted);
  const end = start + highlighted.length;
  await content.evaluate(
    (field, range) => field.setSelectionRange(...range),
    [start, end, "forward"],
  );
  const visiblePng = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 72;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ebe0cb";
      ctx.fillRect(0, 0, 160, 72);
      ctx.fillStyle = "#927540";
      ctx.fillRect(14, 14, 46, 44);
      ctx.fillStyle = "#606266";
      ctx.fillRect(76, 14, 70, 9);
      ctx.fillRect(76, 34, 46, 9);
      return canvas.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  await choose({
    name: "misdeclared.jpg",
    mimeType: "image/jpeg",
    buffer: visiblePng,
  });
  const pngURI = "data:image/png;base64," + visiblePng.toString("base64");
  await view.locator('img[src^="data:image/png;"]').waitFor();
  const withPNG =
    original.slice(0, end) +
    "\n\n![图片](" +
    pngURI +
    ")" +
    original.slice(end);
  assert.equal(await content.inputValue(), withPNG);
  assert.deepEqual(
    await content.evaluate((field) => [
      field.selectionStart,
      field.selectionEnd,
      field.selectionDirection,
    ]),
    [start, end, "forward"],
  );
  assert(await focusIs(content));
  const localImage = view.locator('img[src^="data:image/png;"]');
  await localImage.evaluate((image) => image.decode());
  assert.equal(await localImage.evaluate((image) => image.naturalWidth), 160);
  if (process.env.WORKSPACE_DOCUMENT_IMAGE_CAPTURE) {
    assert.deepEqual(snapshots, []);
    await page.screenshot({
      path: process.env.WORKSPACE_DOCUMENT_IMAGE_CAPTURE,
      clip: { x: 371, y: 176, width: 976, height: 388 },
      caret: "hide",
      animations: "disabled",
    });
  }
  const jpeg = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 2;
      canvas.height = 2;
      canvas.getContext("2d").fillRect(0, 0, 2, 2);
      return canvas.toDataURL("image/jpeg").split(",")[1];
    }),
    "base64",
  );
  await page.setViewportSize({ width: 430, height: 770 });
  await content.evaluate((field) =>
    field.setSelectionRange(field.value.length, field.value.length),
  );
  await choose({
    name: "misdeclared.png",
    mimeType: "image/png",
    buffer: jpeg,
  });
  await view.locator('img[src^="data:image/jpeg;"]').waitFor();
  const expected =
    withPNG +
    "\n\n![图片](data:image/jpeg;base64," +
    jpeg.toString("base64") +
    ")";
  assert.equal(await content.inputValue(), expected);
  assert(await focusIs(content));
  assert.deepEqual(
    await page.evaluate(() => {
      const { clientWidth, scrollWidth } = document.documentElement;
      return [window.innerWidth, scrollWidth - clientWidth];
    }),
    [430, 0],
  );
  assert.deepEqual(snapshots, []);
  assert.equal(
    (await app.store.get(project.id)).documents[0].content,
    original,
  );
  allowSave = true;
  await work
    .getByRole("button", { name: "保存项目", exact: true })
    .press("Enter");
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].documents[0].content, expected);
  await page.reload();
  await page.setViewportSize({ width: 1363, height: 1023 });
  await page.locator('[data-document-index="0"]').press("Enter");
  await view.locator("img").first().waitFor();
  assert.equal(await view.locator("img").count(), 2);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "WORKSPACE_DOCUMENT_LOCAL_IMAGE_PASS chooser/cancel/type/browser-decode/selection/stale/narrow/explicit-save",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
