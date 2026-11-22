import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { normalizeProtocol } from "../src/protocol-definitions.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "api-sidebar-tree-"));
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("默认项目");
  const endpoint = "http://127.0.0.1:38982";
  const title = "什么是Apipost单机版？";
  const verification = normalizeRequest({
    id: "verification",
    name: "Verification",
    method: "GET",
    url: endpoint + "/verification",
  });
  project.requests.push(
    verification,
    ...[
      ["create", "创建用户", "POST"],
      ["read", "获取用户信息", "GET"],
      ["update", "修改用户信息", "PUT"],
      ["remove", "删除用户", "DELETE"],
    ].map(([id, name, method]) =>
      normalizeRequest({
        id,
        name,
        method,
        url: endpoint + "/" + id,
        folder: "示例接口",
      }),
    ),
  );
  project.documents.push({
    id: "fixture-document",
    title,
    content: "# 本地测试用文档\n\n本文仅为界面验证生成。",
  });
  project.protocols.push(
    normalizeProtocol({
      id: "sse-sample",
      type: "sse",
      name: "SSE调试示例",
      folder: "示例接口",
      url: endpoint + "/sse",
    }),
  );
  await app.store.save(project);
  const initial = await app.store.get(project.id);
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
  page.setDefaultTimeout(7500);
  const origin = new URL(app.launchUrl).origin;
  const errors = [],
    blocked = [],
    metrics = {};
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.route("**/*", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "GET" && url.origin === origin)
      return route.continue();
    blocked.push([req.method(), url.pathname]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const editor = page.locator('.editor[data-editor-mode="debug"]');
  await editor.locator('[data-param="auth"]').click();
  const sidebar = page.locator('.sidebar[data-sidebar-page="apis"]');
  const tree = sidebar.locator("#tree");
  const rootRequest = tree.locator(':scope > [data-request="verification"]');
  const doc = tree.locator(':scope > [data-document-index="0"]');
  const folder = tree.locator(':scope > [data-tree-folder="示例接口"]');
  const summary = folder.locator(":scope > summary");
  const drafts = editor.locator("#request-name");
  const labels = () =>
    tree
      .locator(".tree-item:visible")
      .evaluateAll((rows) =>
        rows.map((row) =>
          [...row.querySelectorAll("span")]
            .map((span) => span.textContent)
            .join(" "),
        ),
      );
  const expanded = [
    "MD " + title,
    "POST 创建用户",
    "GET 获取用户信息",
    "PUT 修改用户信息",
    "DEL 删除用户",
    "SSE SSE调试示例",
    "GET Verification",
  ];
  const collapsed = [expanded[0], expanded.at(-1)];
  assert.equal(await folder.getAttribute("open"), "");
  assert.equal(await tree.locator('[data-tree-folder=""]').count(), 0);
  assert.equal(await rootRequest.getAttribute("aria-current"), "true");
  assert.deepEqual(await labels(), expanded);
  assert.equal(await summary.locator(".tree-folder-count").innerText(), "(5)");
  const rect = async (el) => {
    const box = await el.boundingBox();
    assert.ok(box);
    return Object.fromEntries(
      Object.entries(box).map(([key, value]) => [key, Math.round(value)]),
    );
  };
  const child = folder.locator('[data-request="create"]');
  const createControl = sidebar.locator(".tree-create > summary");
  const measure = async () => ({
    doc: await rect(doc),
    folder: await rect(summary),
    selected: await rect(rootRequest),
    create: await rect(createControl),
    rootMethod: await rect(rootRequest.locator(".method")),
    rootTitle: await rect(rootRequest.locator("span").last()),
  });
  metrics.expanded = await measure();
  Object.assign(metrics.expanded, {
    child: await rect(child),
    childMethod: await rect(child.locator(".method")),
    childTitle: await rect(child.locator("span").last()),
  });
  const prefix = process.env.API_TREE_CAPTURE_PREFIX;
  const capture = async (state) => {
    if (!prefix) return;
    await page.mouse.move(800, 87);
    await page.screenshot({
      path: `${prefix}-${state}.png`,
      caret: "hide",
      animations: "disabled",
      clip: { x: 0, y: 0, width: 1363, height: 980 },
    });
  };
  await page.evaluate(() => document.activeElement?.blur());
  await capture("expanded");
  await summary.press("Enter");
  await page.waitForFunction(
    () => !document.querySelector('[data-tree-folder="示例接口"]').open,
  );
  assert.deepEqual(await labels(), collapsed);
  metrics.collapsed = await measure();
  await editor.locator(".http-auth-pane select").focus();
  await capture("collapsed");
  for (const state of ["expanded", "collapsed"]) {
    const m = metrics[state];
    assert.deepEqual(
      [m.doc.x, m.doc.y, m.folder.y, m.doc.height, m.folder.height],
      [62, 130, 160, 30, 30],
      JSON.stringify(m),
    );
    assert.deepEqual(
      [
        m.selected.x,
        m.selected.y,
        m.selected.height,
        m.rootMethod.x,
        m.rootTitle.x,
      ],
      [62, state === "expanded" ? 340 : 190, 30, 90, 133],
      JSON.stringify(m),
    );
    assert.equal(m.create.y - (m.selected.y + m.selected.height), 4);
  }
  assert.deepEqual(
    [
      metrics.expanded.child.y,
      metrics.expanded.childMethod.x,
      metrics.expanded.childTitle.x,
    ],
    [190, 114, 157],
  );

  const search = sidebar.locator("#search");
  const type = sidebar.locator("#tree-type");
  await search.fill("/UPDATE");
  await page.waitForFunction(
    () => document.querySelector('[data-tree-folder="示例接口"]').open,
  );
  assert.deepEqual(await labels(), ["PUT 修改用户信息"]);
  await search.fill("");
  await page.waitForFunction(
    () => !document.querySelector('[data-tree-folder="示例接口"]').open,
  );
  assert.deepEqual(await labels(), collapsed);
  await summary.press("Space");
  await child.click();
  const owningTab = await child.getAttribute("data-request");
  assert.equal(await drafts.inputValue(), "创建用户");
  await drafts.fill("本地未保存草稿");
  await summary.press("Space");
  assert.equal(await folder.locator(".tree-item.active").isVisible(), false);
  await type.selectOption("document");
  await search.fill("筛选遮住当前接口");
  await sidebar.locator("#locate-request").click();
  assert.equal(await search.inputValue(), "");
  assert.equal(await type.inputValue(), "all");
  assert.equal(await drafts.inputValue(), "本地未保存草稿");
  assert.equal(await child.getAttribute("aria-current"), "true");
  assert.equal(
    await child.evaluate((row) => row === document.activeElement),
    true,
  );
  assert.equal(
    await child.locator("span").last().innerText(),
    "本地未保存草稿",
  );

  const dialog = page.locator("#dialog");
  const close = () =>
    dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const settings = summary.getByRole("button", { name: "编辑目录 示例接口" });
  await settings.press("Enter");
  await dialog.getByText("编辑目录", { exact: true }).waitFor();
  assert.equal(await dialog.locator("#folder-name").inputValue(), "示例接口");
  await close();
  assert.equal(await folder.getAttribute("open"), "");
  for (const button of ["#import", "#export"]) {
    await sidebar.locator(button).click();
    await dialog.waitFor();
    await close();
  }
  await createControl.press("Space");
  await sidebar.locator("#new-folder").click();
  await dialog.getByText("新建目录", { exact: true }).waitFor();
  await close();

  await type.selectOption("sse");
  assert.deepEqual(await labels(), ["SSE SSE调试示例"]);
  await tree.getByRole("button", { name: "SSE SSE调试示例" }).click();
  assert.equal(
    await page.locator("#protocol-name").inputValue(),
    "SSE调试示例",
  );
  assert.equal(
    await page.locator("#protocol-url").inputValue(),
    endpoint + "/sse",
  );
  await page.locator("#tree-type").selectOption("document");
  await page.locator('#tree [data-document-index="0"]').click();
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  assert.equal(
    await page.locator('.rail [data-page="apis"]').getAttribute("aria-current"),
    "page",
  );
  await page.locator(`[data-open-tab="${owningTab}"]`).press("Enter");
  assert.equal(await drafts.inputValue(), "本地未保存草稿");
  assert.equal(await type.inputValue(), "document");
  await type.selectOption("all");
  await page.setViewportSize({ width: 600, height: 780 });
  const narrow = await rect(sidebar);
  const narrowChild = await rect(child);
  const inside = (box) =>
    box.x >= narrow.x && box.x + box.width <= narrow.x + narrow.width;
  assert.ok(inside(narrowChild));
  assert.ok(inside(await rect(rootRequest.locator("span").last())));
  assert.equal(
    (await rect(child.locator(".method"))).x -
      (await rect(rootRequest.locator(".method"))).x,
    18,
  );
  await type.selectOption("sse");
  assert.deepEqual(await labels(), ["SSE SSE调试示例"]);
  await type.selectOption("all");
  await summary.press("Space");
  await page.waitForFunction(
    () => !document.querySelector('[data-tree-folder="示例接口"]').open,
  );
  assert.equal(await child.isVisible(), false);
  await sidebar.locator("#locate-request").click();
  assert.equal(await child.isVisible(), true);
  assert.equal(await drafts.inputValue(), "本地未保存草稿");
  metrics.narrow = { sidebar: narrow, child: narrowChild };
  assert.deepEqual(await app.store.get(project.id), initial);
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  if (prefix)
    await writeFile(
      prefix + ".json",
      JSON.stringify(
        { metrics, expanded, collapsed, errors, blocked },
        null,
        2,
      ) + "\n",
    );
  console.log(
    "API_SIDEBAR_TREE_UI_PASS direct-root/folder/collapse/filters/cross-protocol/keyboard/narrow/locate-draft/no-writes/no-dispatch",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
