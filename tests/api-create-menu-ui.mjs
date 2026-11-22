import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.API_CREATE_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-api-create-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  let project = await app.store.create("默认项目");
  project.requests = [
    normalizeRequest({
      id: "fixture",
      name: "Verification",
      method: "GET",
      url: "http://127.0.0.1:38982/no-send",
    }),
    normalizeRequest({
      id: "other",
      name: "Trash Visual Fixture",
      method: "POST",
    }),
  ];
  project.documents = [
    { id: "notes", title: "本地说明", content: "# 合成 Markdown" },
  ];
  project.folders = ["示例接口"];
  project.protocols = [
    {
      id: "existing",
      name: "Existing WS definition",
      type: "websocket",
      url: "ws://127.0.0.1:38982/never-connect",
    },
  ];
  project = await app.store.save(project);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const origin = new URL(app.launchUrl).origin,
    blocked = [],
    errors = [];
  page.on("pageerror", () => errors.push("pageerror"));
  await page.route("**/*", (route) => {
    const req = route.request(),
      u = new URL(req.url());
    if (u.origin === origin && req.method() === "GET" && u.pathname !== "/mcp")
      return route.continue();
    blocked.push(req.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(
    (id) =>
      document.querySelector("#project-select option[selected]")?.value === id,
    project.id,
  );
  const trigger = page.locator(".tree-create > summary");
  const panel = page.getByRole("region", {
    name: "新建或导入项目内容",
    exact: true,
  });
  const tile = (name) => panel.getByRole("button", { name, exact: true });
  const focused = (locator) =>
    locator.evaluate((node) => node === document.activeElement);
  const open = async () => {
    await trigger.press("Space");
    await panel.waitFor();
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    assert(await focused(tile("HTTP 接口")));
  };
  const close = async () => {
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    assert(await focused(trigger));
  };
  const capture = async (name) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    const desktop = page.viewportSize().width === 1363;
    await page.screenshot({
      path: join(evidence, "api-create-" + name + ".png"),
      ...(desktop ? { clip: { x: 0, y: 0, width: 1363, height: 580 } } : {}),
      caret: "hide",
    });
  };
  const boxes = async () => ({
    panel: await panel.boundingBox(),
    trigger: await trigger.boundingBox(),
    http: await tile("HTTP 接口").boundingBox(),
    sse: await tile("Event Stream · SSE").boundingBox(),
    folder: await tile("新建目录").boundingBox(),
  });
  await open();
  const desktop = await boxes();
  console.log("API_CREATE_MENU", "desktop", JSON.stringify(desktop));
  await page.mouse.move(950, 560);
  await capture("desktop");
  assert.ok(Math.abs(desktop.panel.x - 352) <= 3);
  assert.equal(Math.round(desktop.panel.width), 446);
  assert.equal(Math.round(desktop.http.height), 40);
  assert.equal(
    Math.round(desktop.sse.x - desktop.http.x - desktop.http.width),
    8,
  );
  assert.equal(Math.round(desktop.folder.width), 420);
  assert.equal(await tile("GraphQL 请求").count(), 1);
  await tile("HTTP 接口").press("Tab");
  assert(await focused(tile("Event Stream · SSE")));
  await close();
  const activate = async (label) => {
    await open();
    await tile(label).press("Enter");
    await panel.waitFor({ state: "hidden" });
  };
  const dialog = page.locator("#dialog");
  const closeDialog = async () => {
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert(await focused(trigger));
  };
  await activate("新建目录");
  await dialog.getByText("新建目录", { exact: true }).waitFor();
  await closeDialog();
  await activate("Markdown 文档");
  await dialog.locator("#document-content").waitFor();
  await closeDialog();
  for (const [label, selector] of [
    ["粘贴 cURL", "#import-text"],
    ["粘贴接口定义", "#import-text"],
    ["选择本地文件", "#import-file"],
  ]) {
    await activate(label);
    const input = dialog.locator(selector);
    assert(await focused(input));
    if (label === "粘贴 cURL")
      assert.match(await input.getAttribute("placeholder"), /不执行命令/);
    await closeDialog();
  }
  for (const [label, type] of [
    ["WebSocket", "websocket"],
    ["TCP 客户端", "tcp"],
    ["Event Stream · SSE", "sse"],
  ]) {
    await activate(label);
    const select = page.locator("#protocol-type");
    assert.equal(await select.inputValue(), type);
    assert.equal(await page.locator("#protocol-name").inputValue(), "");
    assert.equal(await page.locator("#protocol-url").inputValue(), "");
    assert(await focused(page.locator("#protocol-name")));
    await page.locator('.rail [data-page="apis"]').press("Enter");
  }
  for (const [label, selector] of [
    ["gRPC unary 调试", "#grpc-unary-workbench"],
    ["Socket.IO 调试", "#socketio-workbench"],
  ]) {
    await activate(label);
    await page.locator(selector).waitFor();
    await page.locator('.rail [data-page="apis"]').press("Enter");
  }
  await page.setViewportSize({ width: 430, height: 760 });
  await open();
  const narrow = await boxes();
  console.log("API_CREATE_MENU", "narrow", JSON.stringify(narrow));
  assert(narrow.panel.x >= 12 && narrow.panel.x + narrow.panel.width <= 418);
  assert(narrow.panel.y >= 12 && narrow.panel.y + narrow.panel.height <= 748);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await capture("narrow");
  await close();
  await activate("HTTP 接口");
  assert.equal(await page.locator("#saved-state").textContent(), "● 未保存");
  assert.equal(await page.locator(".tab-scroll .tab-switch").count(), 2);
  assert.equal(await page.locator("#method").inputValue(), "GET");
  await activate("GraphQL 请求");
  const graphql = page.getByRole("region", { name: "GraphQL 请求编辑" });
  await graphql.waitFor();
  assert(await focused(graphql.getByRole("textbox", { name: "Query" })));
  assert.equal(await page.locator("#method").inputValue(), "POST");
  assert.equal(await page.locator("#method").isDisabled(), true);
  assert.equal(await page.locator("#url").inputValue(), "");
  assert.match(
    await page.locator(".tab.selected .method").textContent(),
    /GraphQL/,
  );
  const after = await app.store.get(project.id);
  assert.equal(after.configRevision, project.configRevision);
  assert.deepEqual(after.requests, project.requests);
  assert.deepEqual(after.documents, project.documents);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "API_CREATE_MENU_UI_PASS desktop/narrow/keyboard/real-actions/cancel/no-writes/no-dispatch",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
