import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp("/tmp/workbench-local-document-");
const app = await createApp({ root, port: 0 });
const captures = process.env.WORKSPACE_DOCUMENT_SCREENSHOTS;
const original = {
  id: "verification-document",
  title: "Verification Notes",
  content:
    "# Verification Notes\n\nLocal synthetic document.\n\n- Request: Verification\n- Status: draft",
  folder: "Examples",
  statusId: "developing",
  attributes: { owner: "Synthetic metadata" },
};
let browser;
try {
  const project = await app.store.create("默认项目");
  const request = normalizeRequest({
    id: "verification",
    name: "Verification",
    url: "http://127.0.0.1:38982/verification",
  });
  const background = { id: "intro-doc", title: "项目说明", content: "# 简介" };
  project.requests = [request];
  project.documents = [
    background,
    { ...original, folder: captures ? "" : original.folder },
  ];
  project.settings.statuses = [
    { id: "developing", name: "开发中", color: "#3366ff" },
  ];
  project.settings.attributes = [
    { key: "owner", label: "Owner", type: "string" },
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
  const errors = [],
    forbidden = [],
    snapshots = [];
  let permit = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin === origin && req.method() === "GET")
      return route.continue();
    if (
      !captures &&
      permit &&
      url.origin === origin &&
      url.pathname === "/api/projects/" + project.id &&
      req.method() === "PUT"
    ) {
      permit = false;
      snapshots.push(req.postDataJSON());
      return route.continue();
    }
    forbidden.push(req.method() + " " + url.pathname);
    return route.abort();
  });
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.goto(app.launchUrl);
  const locate = page.locator('[data-document-index="1"]');
  const docTab = page.locator('[data-open-document-tab="' + original.id + '"]');
  const requestTab = page.locator('[data-open-tab="verification"]');
  const work = page.getByRole("region", { name: "本地 Markdown 文档" });
  const preview = work.getByRole("article", { name: "文档预览" });
  const content = work.getByRole("textbox", { name: "Markdown 正文" });
  const edit = work.getByRole("button", { name: "编辑", exact: true });
  const reader = work.getByRole("button", { name: "预览", exact: true });
  const toolbar = work.getByRole("group", { name: "文档格式工具" });
  const toolNames = [
    "标题",
    "加粗",
    "斜体",
    "引用",
    "链接",
    "行内代码",
    "代码块",
    "无序列表",
    "有序列表",
    "删除线",
    "任务列表",
    "表格",
  ];
  const toolbarMetrics = () =>
    toolbar.evaluate((surface) =>
      [...surface.querySelectorAll("button")].map((button) => {
        const rect = button.getBoundingClientRect();
        const svg = button.querySelector("svg");
        const icon = svg?.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          svg: icon && [icon.width, icon.height],
          decorative: svg?.getAttribute("aria-hidden"),
          label: button.getAttribute("aria-label"),
        };
      }),
    );
  const validateTools = (measurements) => {
    assert.deepEqual(
      measurements.map((item) => item.label),
      toolNames,
    );
    for (const { width, height, svg, decorative } of measurements)
      assert.deepEqual(
        [width, height, svg, decorative],
        [36, 32, [16, 16], "true"],
      );
  };
  const measureToolPixels = async (png, measurements) =>
    page.evaluate(
      async ({ encoded, centers }) => {
        const image = new Image();
        image.src = "data:image/png;base64," + encoded;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return centers.map(([x, y]) => {
          const pixels = context.getImageData(x - 8, y - 8, 16, 16).data;
          let ink = 0,
            blue = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
            if (r < 160 && g < 150 && b < 135) ink++;
            if (b > r + 14 && b > g + 6) blue++;
          }
          return { ink, blue };
        });
      },
      {
        encoded: png.toString("base64"),
        centers: measurements.map(({ x, y }) => [x, y]),
      },
    );
  const active = (locator) =>
    locator.evaluate((element) => element === document.activeElement);
  await page.locator("#url").waitFor();
  if (!captures)
    await page.locator("#url").fill(request.url + "?local-draft=true");
  await locate.press("Enter");
  assert(await active(docTab));
  assert.equal(await docTab.getAttribute("aria-current"), "page");
  assert.equal(await locate.getAttribute("aria-current"), "true");
  assert.equal(
    await page.locator('.rail [data-page="apis"]').getAttribute("aria-current"),
    "page",
  );
  assert.equal(await page.locator("#send").count(), 0);
  await preview.getByRole("heading", { name: original.title }).waitFor();
  let editor, panes, tools, iconPixels;
  if (captures) {
    const snapshot = (state) =>
      page.screenshot({
        path: join(captures, "docs-workbench-" + state + ".png"),
        clip: { x: 0, y: 0, width: 1363, height: 980 },
        animations: "disabled",
        caret: "hide",
      });
    await docTab.blur();
    await page.mouse.move(1352, 175);
    await snapshot("preview-populated");
    await edit.press("Enter");
    assert(await active(content));
    assert.equal(await content.inputValue(), original.content);
    editor = await content.boundingBox();
    panes = await preview.boundingBox();
    const frame = await work
      .locator(".workspace-document-editor")
      .boundingBox();
    assert.deepEqual(
      [frame.x, frame.x + frame.width, editor.y, panes.x],
      [371, 1347, 209, 859],
    );
    assert.equal(panes.y, editor.y);
    assert(Math.abs(panes.x - editor.x - editor.width) < 1);
    tools = await toolbarMetrics();
    validateTools(tools);
    assert.deepEqual(
      tools.map(({ x }) => x),
      toolNames.map((_, i) => 402 + 36 * i),
    );
    assert(tools.every(({ y }) => y === 193));
    await content.blur();
    iconPixels = await measureToolPixels(
      await snapshot("editor-populated"),
      tools,
    );
    assert(
      iconPixels.every(({ ink, blue }) => ink >= 10 && blue === 0),
      JSON.stringify(iconPixels),
    );
    assert.deepEqual(
      (await app.store.get(project.id)).documents,
      project.documents,
    );
  } else {
    await edit.press("Enter");
    assert(await active(content));
    validateTools(await toolbarMetrics());
    await toolbar
      .getByRole("button", { name: "标题", exact: true })
      .press("Tab");
    assert(
      await active(toolbar.getByRole("button", { name: "加粗", exact: true })),
    );
    const newTitle = "Verification Notes Updated";
    await work.getByRole("textbox", { name: "文档标题" }).fill(newTitle);
    assert.match(await docTab.innerText(), /Verification Notes Updated/);
    const next =
      original.content +
      "\n\n<script>globalThis.breakOut = true;</script>\n\n![remote](https://example.invalid/never-fetch)";
    await content.fill(next);
    await preview
      .getByText("<script>globalThis.breakOut = true;</script>", {
        exact: true,
      })
      .waitFor();
    assert.equal(await preview.locator("script, img").count(), 0);
    assert.equal(await page.evaluate(() => globalThis.breakOut), undefined);
    await content.evaluate((field) => {
      const start = field.value.indexOf("Local synthetic document.");
      field.setSelectionRange(
        start,
        start + "Local synthetic document.".length,
      );
    });
    await work
      .getByRole("button", { name: "加粗", exact: true })
      .press("Enter");
    assert(await active(content));
    await preview
      .locator("strong")
      .getByText("Local synthetic document.")
      .waitFor();
    const expected = next.replace(
      "Local synthetic document.",
      "**Local synthetic document.**",
    );
    assert.equal(await content.inputValue(), expected);
    await reader.press("Enter");
    await work.getByRole("heading", { name: newTitle, exact: true }).waitFor();
    await requestTab.press("Enter");
    assert(await active(requestTab));
    assert.equal(
      await page.locator("#url").inputValue(),
      request.url + "?local-draft=true",
    );
    await docTab.press("Enter");
    await edit.press("Enter");
    assert.equal(await content.inputValue(), expected);

    await page.setViewportSize({ width: 430, height: 770 });
    const narrowEditor = await content.boundingBox();
    const narrowPreview = await preview.boundingBox();
    assert(narrowPreview.y >= narrowEditor.y + narrowEditor.height);
    assert.deepEqual(
      await page.evaluate(() => {
        const { clientWidth, scrollWidth } = document.documentElement;
        return [window.innerWidth, scrollWidth - clientWidth];
      }),
      [430, 0],
      "a classic vertical scrollbar may reduce the usable width, but not create horizontal overflow",
    );
    const narrowTools = await toolbarMetrics();
    validateTools(narrowTools);
    const toolbarRect = await toolbar.boundingBox();
    assert(
      narrowTools.every(
        ({ x, y }) =>
          x - 18 >= toolbarRect.x &&
          x + 18 <= toolbarRect.x + toolbarRect.width &&
          y - 16 >= toolbarRect.y &&
          y + 16 <= toolbarRect.y + toolbarRect.height,
      ),
    );
    assert(new Set(narrowTools.map(({ y }) => y)).size > 1);
    await work.getByRole("button", { name: "文档设置" }).press("Enter");
    const dialog = page.locator("#dialog");
    assert.equal(
      await dialog.locator("#document-folder").inputValue(),
      original.folder,
    );
    assert.equal(
      await dialog.locator("#document-status").inputValue(),
      original.statusId,
    );
    assert.equal(
      await dialog.locator('[data-doc-attribute="owner"]').inputValue(),
      original.attributes.owner,
    );
    assert.equal(
      await dialog.locator("#document-image").getAttribute("accept"),
      "image/png,image/jpeg",
    );
    await dialog
      .getByRole("button", { name: "关闭", exact: true })
      .press("Enter");
    await dialog.waitFor({ state: "hidden" });
    assert(await active(work.getByRole("button", { name: "文档设置" })));
    await page
      .locator('[data-close-document-tab="' + original.id + '"]')
      .press("Enter");
    assert(await active(requestTab));
    await locate.press("Enter");
    assert.equal(
      await content.inputValue(),
      expected,
      "closing a tab retains the normal project draft",
    );
    assert.deepEqual(snapshots, []);
    const baseline = await app.store.get(project.id);
    assert.deepEqual(baseline.documents[1], original);
    assert.equal(baseline.requests[0].url, request.url);
    permit = true;
    await work
      .getByRole("button", { name: "保存项目", exact: true })
      .press("Enter");
    await page
      .locator("#saved-state")
      .getByText("✓ 已保存", { exact: true })
      .waitFor();
    assert.equal(snapshots.length, 1);
    assert.deepEqual(snapshots[0].documents, [
      background,
      { ...original, title: newTitle, content: expected },
    ]);
    assert.equal(
      snapshots[0].requests[0].url,
      request.url + "?local-draft=true",
    );
    await page.reload();
    await locate.press("Enter");
    await work.getByRole("heading", { name: newTitle, exact: true }).waitFor();
    await preview
      .locator("strong")
      .getByText("Local synthetic document.")
      .waitFor();
    await page.setViewportSize({ width: 1363, height: 1023 });
    await page.locator('.rail [data-page="docs"]').click();
    await page
      .getByRole("heading", { name: "接口文档", exact: true })
      .waitFor();
    assert.equal(await page.locator('[data-edit-document="1"]').count(), 1);
    assert.equal(await page.locator("#export-docs").count(), 1);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(forbidden, []);
  console.log(
    JSON.stringify({
      editor,
      panes,
      tools,
      iconPixels,
      writes: snapshots.length,
      errors,
      forbidden,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
