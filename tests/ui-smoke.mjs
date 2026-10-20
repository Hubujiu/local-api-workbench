import { startNtlmFixture } from "./fixtures/ntlm-server.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
import { parseRESP } from "../src/redis.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { snapshotPlan, exportOpenAPI, normalizeRequest } from "../src/core.mjs";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({
    chromium,
  } = require("/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
}
const root = await mkdtemp(path.join(os.tmpdir(), "local-api-ui-"));
const app = await createApp({ root, port: 0 });
const ntlmFixture = await startNtlmFixture();
let uploadedMultipart,
  stdioChild,
  releaseMCP = () => {},
  mcpGate = Promise.resolve();
const fixture = http.createServer(async (request, response) => {
  if (request.url.startsWith("/global-parameters")) {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        token: request.headers["x-global-fixture"] || "absent",
        authorization: request.headers.authorization || "",
        sharedScript: request.headers["x-shared-script"] || "absent",
        url: request.url,
      }),
    );
  } else if (request.url === "/upload") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    uploadedMultipart = {
      body: Buffer.concat(chunks),
      headers: request.headers,
    };
    response.setHeader("content-type", "application/json");
    response.end('{"received":true}');
  } else if (request.url === "/sse") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: ui-stream-fixture\n\n");
  } else if (request.url === "/slow-mcp") {
    await mcpGate;
    response.end("{}");
  } else if (request.url === "/auth") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ authorization: request.headers.authorization }),
    );
  } else if (request.url === "/token") {
    for await (const _chunk of request) {
    }
    response.setHeader("content-type", "application/json");
    response.end('{"access_token":"ui-fixture-token","token_type":"Bearer"}');
  } else {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const fixtureURL = `http://127.0.0.1:${fixture.address().port}`;
const h2Sessions = new Set(),
  h2Sockets = new Set();
let h2Connections = 0;
const h2Fixture = http2.createServer();
h2Fixture.on("session", (session) => {
  h2Sessions.add(session);
  session.on("close", () => h2Sessions.delete(session));
});
h2Fixture.on("stream", (stream, headers) => {
  let body = "";
  stream.on("data", (chunk) => (body += chunk));
  stream.on("end", () => {
    stream.respond({ ":status": 200, "content-type": "application/json" });
    stream.end(
      JSON.stringify({ protocol: "h2", method: headers[":method"], body }),
    );
  });
});
await new Promise((resolve) => h2Fixture.listen(0, "127.0.0.1", resolve));
const h2Proxy = http.createServer();
h2Proxy.on("connect", (_request, client) => {
  h2Connections++;
  const upstream = net.connect(h2Fixture.address().port, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    client.pipe(upstream);
    upstream.pipe(client);
  });
  for (const socket of [client, upstream]) {
    h2Sockets.add(socket);
    socket.on("close", () => h2Sockets.delete(socket));
  }
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});
await new Promise((resolve) => h2Proxy.listen(0, "127.0.0.1", resolve));
const redisSockets = new Set();
const redisFixture = net.createServer((socket) => {
  redisSockets.add(socket);
  socket.on("close", () => redisSockets.delete(socket));
  socket.on("error", () => {});
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const frame = parseRESP(buffer);
    if (!frame) return;
    const command = frame.value.map((value) => value.toString());
    assert.deepEqual(command, ["GET", "ui-fixture"]);
    const value = Buffer.from("redis-ui-fixture");
    socket.end(
      Buffer.concat([
        Buffer.from("$" + value.length + "\r\n"),
        value,
        Buffer.from("\r\n"),
      ]),
    );
  });
});
await new Promise((resolve) => redisFixture.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_BUNDLED
    ? undefined
    : process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 950 },
  recordVideo: { dir: "/tmp/local-api-video" },
});
await page
  .context()
  .tracing.start({ screenshots: true, snapshots: true, sources: true });
async function saveAndWait(selector = "#save-project") {
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/api/projects/") &&
        response.status() === 200,
    ),
    page.locator(selector).click(),
  ]);
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
}
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(app.launchUrl);
  await page.getByRole("button", { name: "发 送", exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/local-api-initial.png" });
  const helperLabelBox = await page
    .locator("#toggle-parameter-helper .helper-label")
    .boundingBox();
  assert(
    helperLabelBox.height >= 50,
    "helper label must have non-overlapping vertical text",
  );
  const originalBody = await page.locator("#body-code").inputValue();
  const normalEditorHeight = (await page.locator("#body-code").boundingBox())
    .height;
  await page.locator("#expand-body").click();
  assert(
    (await page.locator("#body-code").boundingBox()).height >
      normalEditorHeight,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#expand-body").getAttribute("aria-pressed"),
    "false",
  );
  assert.equal(await page.locator("#body-code").inputValue(), originalBody);
  await page.locator("#toggle-parameter-helper").click();
  await page.getByText("插入环境变量", { exact: true }).waitFor();
  await page.locator("#body-code").fill('{"name":""}');
  await page
    .locator("#body-code")
    .evaluate((element) => element.setSelectionRange(9, 9));
  await page.locator("#builtin-variable").selectOption("$randomFirstName");
  await page.locator("#insert-builtin-variable").click();
  assert.equal(
    await page.locator("#body-code").inputValue(),
    '{"name":"{{$randomFirstName}}"}',
  );
  const builtinPanelBox = await page.locator(".parameter-helper").boundingBox();
  const builtinInsertBox = await page
    .locator("#insert-builtin-variable")
    .boundingBox();
  assert(
    builtinInsertBox.y >= builtinPanelBox.y &&
      builtinInsertBox.y + builtinInsertBox.height <=
        builtinPanelBox.y + builtinPanelBox.height,
    "builtin picker stays in view after insertion",
  );
  await page.screenshot({ path: "/tmp/local-api-builtin-variables.png" });
  await page.locator("#body-code").fill(originalBody);

  await page.locator("#toggle-parameter-helper").click();
  assert.equal(await page.locator("#body-code").inputValue(), originalBody);
  await page.locator('summary[aria-label="发送更多操作"]').click();
  await page.locator("#send-menu-curl").click();
  await page.locator("#dialog").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await page.locator('input[name="body-type"][value="none"]').check();
  await page.getByText("此请求没有 Body", { exact: true }).waitFor();
  await page.locator('input[name="body-type"][value="raw"]').check();
  assert.equal(await page.locator("#body-code").inputValue(), originalBody);
  await page.locator("#raw-format").selectOption("raw");
  await page.locator("#raw-format").selectOption("json");

  await page.setViewportSize({ width: 1328, height: 876 });
  const projectGroupBox = await page.locator(".project-group").boundingBox();
  assert(
    Math.abs(projectGroupBox.x + projectGroupBox.width / 2 - 664) < 5,
    "project controls should be centered at reference width",
  );
  assert.equal(await page.locator('.rail [data-page="plans"]').count(), 0);
  assert.equal(await page.locator(".rail button").count(), 7);
  const bodyPanelBox = await page.locator(".request-panel").boundingBox();
  const bodyEditorBox = await page.locator(".body-editor-shell").boundingBox();
  assert(
    bodyEditorBox.y + bodyEditorBox.height <=
      bodyPanelBox.y + bodyPanelBox.height,
    "body editor must fit its panel",
  );
  const urlBarBox = await page.locator(".urlbar").boundingBox();
  const responseTabsBox = await page.locator(".response-tabs").boundingBox();
  assert(
    Math.abs(urlBarBox.y - 138) <= 8,
    "URL bar aligns with official reference vertical rhythm",
  );
  assert(
    responseTabsBox.y >= 490 && responseTabsBox.y <= 525,
    "response separator stays near official reference",
  );
  assert.equal(
    await page
      .locator("#body-code")
      .evaluate((el) => getComputedStyle(el).lineHeight),
    "18px",
  );
  assert(await page.locator(".empty-symbol svg").isVisible());
  const searchFieldBox = await page.locator("#search").boundingBox();
  const typeFilterBox = await page.locator("#tree-type").boundingBox();
  assert(
    Math.abs(searchFieldBox.y - typeFilterBox.y) < 3,
    "type filter must share the search row",
  );
  assert(
    typeFilterBox.x > searchFieldBox.x,
    "type filter follows the search input",
  );
  assert.equal(await page.locator("#new-folder").isVisible(), false);
  await page.locator(".tree-create summary").click();
  if (!(await page.locator("#new-folder").isVisible()))
    await page.locator(".tree-create summary").click();
  await page.locator("#new-folder").click();
  await page.locator("#folder-name").fill("must-not-create-on-cancel");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  assert(
    !(await page.locator("#tree").innerText()).includes(
      "must-not-create-on-cancel",
    ),
  );
  await page.locator(".tree-create summary").click();
  assert.equal(await page.locator("#new-folder").isVisible(), false);
  const activeName = await page.locator("#request-name").inputValue();
  await page.locator("#request-name").fill("定位保留未保存内容");
  await page.locator('[data-tree-folder="示例接口"] > summary').click();
  assert.equal(await page.locator(".tree-item.active").isVisible(), false);
  await page.locator("#search").fill("不存在的过滤条件");
  await page.locator("#tree-type").selectOption("document");
  await page.locator("#locate-request").click();
  assert.equal(await page.locator("#search").inputValue(), "");
  assert.equal(await page.locator("#tree-type").inputValue(), "all");
  assert.equal(await page.locator(".tree-item.active").isVisible(), true);
  assert.equal(
    await page.locator("#request-name").inputValue(),
    "定位保留未保存内容",
  );
  await page.locator("#request-name").fill(activeName);
  assert.equal(
    await page.locator(".tree-item.active span").last().innerText(),
    activeName,
  );
  assert.equal(
    await page.locator(".tab.selected [data-tab-name]").innerText(),
    activeName,
  );
  assert.equal(
    await page
      .locator('[data-tree-folder="示例接口"] > summary')
      .evaluate((el) => getComputedStyle(el).display),
    "list-item",
  );
  await page.locator('[data-param="body"]').click();

  await page.screenshot({ path: "/tmp/local-api-reference-light.png" });
  await page.locator("#compact-ui").click();
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  await page.locator("#response-layout").click();
  const requestSide = await page.locator(".request-panel").boundingBox();
  const responseSide = await page.locator(".response").boundingBox();
  assert(responseSide.x >= requestSide.x + requestSide.width);
  assert.equal(await page.locator("#body-code").inputValue(), originalBody);
  await page.screenshot({ path: "/tmp/local-api-split-layout.png" });
  await page.locator("#response-layout").click();
  await page.locator("#compact-ui").click();
  assert.equal(await page.locator(".sidebar").isVisible(), true);
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.getByRole("button", { name: "发 送", exact: true }).click();
  await page
    .locator(".response-body")
    .getByText("欢迎使用 Local API", { exact: false })
    .waitFor();
  assert(await page.getByText("200", { exact: true }).isVisible());
  await page.getByRole("button", { name: "新建接口", exact: true }).click();
  await page
    .getByRole("textbox", { name: "接口名称", exact: true })
    .fill("UI 保存测试");
  await page
    .getByRole("textbox", { name: "请求 URL", exact: true })
    .fill(app.url + "/api/session");
  await saveAndWait("#save");
  await page.reload();
  await page.locator("#project-select").waitFor();
  assert(
    await page
      .getByRole("button", { name: "GET UI 保存测试", exact: false })
      .isVisible(),
  );
  await page.getByRole("button", { name: "执行计划", exact: false }).click();
  await page.locator("#new-plan").click();
  await page.locator("#plan-name").fill("可重复验证");
  await page.locator("#dialog-save").click();
  assert.equal(
    await page.locator("#plan-status-policy").inputValue(),
    "strict200",
  );
  await page.locator('[data-step-edit="0"]').click();
  await page.locator('[data-step-field="name"]').fill("独立快照步骤");
  await page.locator('[data-step-field="url"]').fill(fixtureURL + "/upload");
  await page.locator('[data-step-field="bodyType"]').selectOption("form-data");
  await page
    .locator("#dialog-content summary")
    .getByText("表单字段（form-data / urlencoded）", { exact: true })
    .click();
  await page.locator('[data-step-add="form"]').click();
  const uploadRow = page
    .locator('[data-step-pairs="form"] [data-step-pair-row]')
    .last();
  await uploadRow.locator("[data-step-key]").fill("attachment");
  await uploadRow.locator("[data-step-form-type]").selectOption("file");
  await uploadRow.locator("[data-step-file]").setInputFiles({
    name: "proof.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0, 1, 255, 13, 10]),
  });
  await uploadRow
    .locator(".step-file-status")
    .getByText("proof.bin", { exact: true })
    .waitFor();
  await page.locator('[data-step-add="form"]').click();
  const textFormRow = page
    .locator('[data-step-pairs="form"] [data-step-pair-row]')
    .last();
  await textFormRow.locator("[data-step-key]").fill("label");
  await textFormRow.locator("[data-step-value]").fill("step-upload");
  await textFormRow.locator(".step-dynamic summary").click();
  await textFormRow.locator("[data-dynamic-enabled]").check();
  await textFormRow.locator('[data-dynamic-field="value"]').fill("{");
  await page.locator("#dialog-save").click();
  await page.getByText("固定动态值必须是有效JSON", { exact: true }).waitFor();
  await textFormRow
    .locator('[data-dynamic-field="value"]')
    .fill('"step-upload"');

  await page
    .locator("#dialog-content summary")
    .getByText("连接与证书", { exact: true })
    .click();
  await page.locator('[data-step-field="timeout"]').fill("3000");
  await page.locator('[data-step-tls="passphrase"]').fill("fixture-passphrase");
  assert.equal(
    await page.locator('[data-step-tls="passphrase"]').getAttribute("type"),
    "password",
  );

  await page
    .locator(".step-editor summary")
    .getByText("Header", { exact: true })
    .click();
  await page.locator('[data-step-add="headers"]').click();
  const newHeader = page
    .locator('[data-step-pairs="headers"] [data-step-pair-row]')
    .last();
  await newHeader.locator("[data-step-key]").fill("x-step-proof");
  await newHeader.locator("[data-step-value]").fill("snapshot");
  await newHeader.locator(".step-dynamic summary").click();
  await newHeader.locator("[data-dynamic-enabled]").check();
  await newHeader
    .locator('[data-dynamic-field="source"]')
    .selectOption("variable");
  await newHeader.locator('[data-dynamic-field="value"]').fill("stepHeader");
  assert.equal(
    await newHeader.locator("[data-dynamic-mock]").isVisible(),
    false,
  );
  assert(
    (await newHeader.locator('[data-dynamic-field="value"]').boundingBox())
      .height <= 100,
  );
  await newHeader.locator(".step-dynamic").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/local-api-step-dynamic.png" });
  await page
    .locator("#dialog-content summary")
    .getByText("本步骤脚本", { exact: true })
    .click();
  await page
    .locator('[data-step-field="beforeScript"]')
    .fill('pm.variables.set("stepHeader","dynamic-wire");');

  await page
    .locator("#dialog-content summary")
    .getByText("认证", { exact: true })
    .click();
  await page.locator("#step-auth #auth-type").selectOption("bearer");
  await page
    .locator('#step-auth [data-auth="token"]')
    .fill("step-fixture-token");
  await page
    .locator("#dialog-content summary")
    .getByText("断言", { exact: true })
    .click();
  await page.locator('[data-step-rule-add="assertions"]').click();
  const stepAssertion = page
    .locator('[data-step-rules="assertions"] [data-step-rule-row]')
    .last();
  await stepAssertion.locator('[data-step-rule-field="target"]').fill("status");
  await stepAssertion.locator('[data-step-rule-field="value"]').fill("200");
  await page
    .locator("#dialog-content summary")
    .getByText("变量提取", { exact: true })
    .click();
  await page.locator('[data-step-rule-add="extract"]').click();
  const stepExtract = page
    .locator('[data-step-rules="extract"] [data-step-rule-row]')
    .last();
  await stepExtract
    .locator('[data-step-rule-field="name"]')
    .fill("stepContentType");
  await stepExtract
    .locator('[data-step-rule-field="source"]')
    .selectOption("header");
  await stepExtract
    .locator('[data-step-rule-field="path"]')
    .fill("content-type");

  await page.screenshot({ path: "/tmp/local-api-step-editor.png" });
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-step-edit="0"]').click();
  assert.equal(
    await page.locator('[data-step-field="timeout"]').inputValue(),
    "3000",
  );
  assert.equal(
    await page.locator('[data-step-tls="passphrase"]').inputValue(),
    "fixture-passphrase",
  );
  assert.match(
    await page.locator('[data-step-pairs="form"]').textContent(),
    /proof.bin/,
  );
  assert.equal(
    await page.locator('[data-step-field="name"]').inputValue(),
    "独立快照步骤",
  );
  assert.equal(
    await page
      .locator('[data-step-pairs="headers"] [data-dynamic-field="value"]')
      .last()
      .inputValue(),
    "stepHeader",
  );
  assert(
    await page
      .locator('[data-step-pairs="headers"] [data-dynamic-enabled]')
      .last()
      .isChecked(),
  );

  assert.equal(
    await page.locator('#step-auth [data-auth="token"]').inputValue(),
    "step-fixture-token",
  );
  assert.equal(
    await page
      .locator('[data-step-rules="assertions"] [data-step-rule-field="value"]')
      .last()
      .inputValue(),
    "200",
  );
  assert.equal(
    await page
      .locator('[data-step-rules="extract"] [data-step-rule-field="name"]')
      .last()
      .inputValue(),
    "stepContentType",
  );

  assert.equal(
    await page
      .locator('[data-step-pairs="headers"] [data-step-value]')
      .last()
      .inputValue(),
    "snapshot",
  );
  await page
    .locator("#dialog-content summary")
    .getByText("认证", { exact: true })
    .click();
  await page
    .locator('#step-auth [data-auth="token"]')
    .fill("must-not-survive-failed-save");
  await page.route("**/api/projects/*/plans", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "fixture plan conflict" }),
        })
      : route.continue(),
  );
  await page.locator("#dialog-save").click();
  await page.getByText("fixture plan conflict", { exact: true }).waitFor();
  await page.unroute("**/api/projects/*/plans");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator('[data-step-edit="0"]').click();
  assert.equal(
    await page.locator('#step-auth [data-auth="token"]').inputValue(),
    "step-fixture-token",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .getByRole("button", { name: "执行计划", exact: true })
    .last()
    .click();
  await page.getByText("✓ 通过", { exact: false }).waitFor();
  assert(
    uploadedMultipart.body.includes(Buffer.from([0, 1, 255, 13, 10])),
    "selected binary file bytes reach real multipart HTTP fixture",
  );
  assert.match(uploadedMultipart.body.toString(), /filename="proof.bin"/);
  assert.match(uploadedMultipart.body.toString(), /step-upload/);
  assert.equal(uploadedMultipart.headers["x-step-proof"], "dynamic-wire");
  assert.equal(
    uploadedMultipart.headers.authorization,
    "Bearer step-fixture-token",
  );
  await page.screenshot({ path: "/tmp/local-api-plan.png" });
  await page.locator('[data-plan-tab="plans"]').click();
  await page.locator('[data-step-edit="0"]').click();
  await page.locator('[data-step-field="bodyType"]').selectOption("json");
  const stepBodyText = page.locator('[data-step-field="body"]');
  await stepBodyText.fill('{"value":}');
  await page
    .locator("#dialog-content summary")
    .getByText("Raw Body动态值", { exact: true })
    .click();
  await page.locator("[data-step-body-add]").click();
  let bodyDynamicRow = page.locator("[data-step-body-dynamic]").last();
  await stepBodyText.evaluate((element) => element.setSelectionRange(9, 9));
  await bodyDynamicRow.locator("[data-step-body-insert]").click();
  assert.match(await stepBodyText.inputValue(), /\{\{@value:/);
  await bodyDynamicRow.locator("[data-step-body-remove]").click();
  assert.equal(await stepBodyText.inputValue(), '{"value":}');
  await page.locator("[data-step-body-add]").click();
  bodyDynamicRow = page.locator("[data-step-body-dynamic]").last();
  const rawDynamicValue = { line: 'a"b', zero: 0 };
  await bodyDynamicRow
    .locator('[data-dynamic-field="value"]')
    .fill(JSON.stringify(rawDynamicValue));
  await stepBodyText.evaluate((element) => element.setSelectionRange(9, 9));
  await bodyDynamicRow.locator("[data-step-body-insert]").click();
  await bodyDynamicRow.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/local-api-step-body-dynamic.png" });
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-step-edit="0"]').click();
  await page
    .locator("#dialog-content summary")
    .getByText("Raw Body动态值", { exact: true })
    .click();
  bodyDynamicRow = page.locator("[data-step-body-dynamic]").last();
  await bodyDynamicRow.locator(".step-dynamic summary").click();
  assert.equal(
    await bodyDynamicRow.locator('[data-dynamic-field="value"]').inputValue(),
    JSON.stringify(rawDynamicValue),
  );
  await bodyDynamicRow.locator("[data-dynamic-enabled]").uncheck();
  await page.locator("#dialog-save").click();
  await page
    .getByText("正文仍引用已关闭或移除的Body动态值", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const bodyDynamicRun = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/run"),
  );
  await page.locator("#run-plan").click();
  const stepBodyDynamicResult = await (await bodyDynamicRun).json();
  assert.equal(stepBodyDynamicResult.status, "passed");
  await page
    .locator("details.card[open] > summary")
    .filter({ hasText: stepBodyDynamicResult.createdAt })
    .getByText("✓ 通过", { exact: true })
    .waitFor();
  assert.deepEqual(JSON.parse(uploadedMultipart.body.toString()), {
    value: rawDynamicValue,
  });
  // An intentionally failing pre-script must expose its assertion without sending.
  await page.locator('[data-plan-tab="plans"]').click();
  await page.locator('[data-step-edit="0"]').click();
  await page
    .locator("#dialog-content summary")
    .getByText("本步骤脚本", { exact: true })
    .click();
  const originalBeforeScript = await page
    .locator('[data-step-field="beforeScript"]')
    .inputValue();
  await page
    .locator('[data-step-field="beforeScript"]')
    .fill(
      'pm.test("visible precondition failure",()=>pm.expect(false).to.equal(true));console.log("precondition evidence");',
    );
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator("#run-plan").click();
  const failedRunStep = page.locator('[data-run-step="0"][open]').first();
  await failedRunStep.getByText("前置脚本断言失败", { exact: true }).waitFor();
  assert.match(
    await failedRunStep.locator(".step-assertions").innerText(),
    /visible precondition failure/,
  );
  assert.equal(
    await failedRunStep
      .getByText("请求配置（未发送）", { exact: true })
      .isVisible(),
    true,
  );
  await failedRunStep.getByText("脚本与操作日志", { exact: true }).click();
  assert.equal(
    await failedRunStep
      .locator('[data-evidence="脚本与操作日志"] pre')
      .filter({ hasText: "precondition evidence" })
      .isVisible(),
    true,
  );
  await page.screenshot({ path: "/tmp/local-api-plan-failure-evidence.png" });
  await page.locator('[data-plan-tab="plans"]').click();
  await page.locator('[data-step-edit="0"]').click();
  await page
    .locator("#dialog-content summary")
    .getByText("本步骤脚本", { exact: true })
    .click();
  await page
    .locator('[data-step-field="beforeScript"]')
    .fill(originalBeforeScript);
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });

  // Exercise editable scripts, response evidence and repeated modal dismissal.
  await page.locator('[data-page="apis"]').click();
  await page.locator('[data-param="after"]').click();
  await page
    .locator("#script-code")
    .fill(
      'pm.environment.set("uiSaved","persisted"); pm.globals.set("uiGlobal",0); pm.test("payload", () => pm.expect(pm.response.code).to.equal(200)); apt.assert("response.raw.status === 200"); postman.setEnvironmentVariable("legacyFromUI",response.json.message); console.log("script-done");' +
        `pm.sendRequest(${JSON.stringify(fixtureURL + "/token")},(error,reply)=>{if(error)throw error;pm.environment.set('scriptHTTPFromUI',reply.json().access_token);pm.test('scriptHTTPStatus',()=>pm.expect(reply.code).to.equal(200));});`,
    );
  await page.locator("#send").click();
  await page.locator('[data-response="logs"]').click();
  await page
    .locator(".response-body")
    .getByText("script-done", { exact: false })
    .waitFor();
  await saveAndWait("#save");
  const scopeSavedProject = (await app.store.list()).find(
    (item) => !item.archived,
  );
  const scopeSaved = await app.store.get(scopeSavedProject.id);
  assert.equal(scopeSaved.environments[0].variables.uiSaved, "persisted");
  assert.equal(
    scopeSaved.environments[0].variables.legacyFromUI,
    "欢迎使用 Local API",
  );
  assert.equal(scopeSaved.globalVariables.uiGlobal, 0);
  assert.equal(
    scopeSaved.environments[0].variables.scriptHTTPFromUI,
    "ui-fixture-token",
  );
  await page.locator('[data-response="subrequests"]').click();
  await page
    .locator(".response-body")
    .getByText("ui-fixture-token", { exact: false })
    .waitFor();
  await page.screenshot({ path: "/tmp/local-api-script-http.png" });
  const preLoadRevision = (await app.store.get(scopeSavedProject.id))
    .configRevision;
  await page.locator('[data-mode="load"]').click();
  await page.locator("#load-count").fill("0");
  await page.locator("#load-run").click();
  await page
    .getByText("压测次数须为1至100整数，并发须为1至10整数", { exact: true })
    .waitFor();

  await page.locator("#load-count").fill("2");
  await page.locator("#load-concurrency").fill("2");
  await page.locator("#load-data").fill("id,id\n1,2");
  await page.locator("#load-run").click();
  await page
    .getByText("压测CSV变量名为空、重复或无效", { exact: true })
    .waitFor();
  const csv = "loadFixture\nfirst\nsecond";
  await page.locator("#load-data-file").setInputFiles({
    name: "data.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page.waitForFunction(
    (value) => document.querySelector("#load-data").value === value,
    csv,
  );
  await page.locator('[data-mode="debug"]').click();
  await page.locator('[data-mode="load"]').click();
  assert.equal(await page.locator("#load-data").inputValue(), csv);
  page.once("dialog", (dialog) => {
    assert.match(dialog.message(), /有权/);
    dialog.accept();
  });
  const loadResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/load"),
  );
  await page.locator("#load-run").click();
  const loadPayload = await (await loadResponse).json();
  assert.equal(loadPayload.passed, 2, JSON.stringify(loadPayload));
  assert.equal(loadPayload.scriptRequests, 2);
  assert.equal(loadPayload.mainRequests, 2);
  assert.equal(loadPayload.variableIsolation, "per-request");
  assert.equal(loadPayload.dataRows, 2);
  assert.deepEqual(
    loadPayload.results.map((r) => r.dataRow),
    [1, 2],
  );
  assert.equal(await page.locator("#load-data").inputValue(), csv);
  assert.equal(
    (await app.store.get(scopeSavedProject.id)).configRevision,
    preLoadRevision,
  );
  await page
    .locator(".grid-stats")
    .getByText("脚本子请求", { exact: false })
    .waitFor();
  assert.equal(await page.locator("#load-count").inputValue(), "2");
  assert.equal(await page.locator("#load-concurrency").inputValue(), "2");
  const csvBox = await page.locator("#load-data").boundingBox();
  assert(csvBox.width >= 500, "CSV editor is wide enough to inspect rows");
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-load-pipeline.png" });
  await page.locator('[data-mode="debug"]').click();

  await page.locator("#import").click();
  await page.locator("#dialog").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator("#import").click();
  await page
    .locator("#import-text")
    .fill(`curl -X GET '${app.url}/api/session'`);
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert((await page.locator("[data-request]").count()) === 3);
  await page.locator(".response-body .empty").waitFor();
  assert(
    !(await page.locator(".response-body").innerText()).includes("script-done"),
  );
  await page.locator("#theme").click();
  assert(
    await page
      .locator("body")
      .evaluate((element) => element.classList.contains("dark")),
  );
  await page.screenshot({ path: "/tmp/local-api-dark.png" });
  await page.setViewportSize({ width: 1328, height: 876 });
  await page.screenshot({ path: "/tmp/local-api-reference-dark.png" });
  await page.setViewportSize({ width: 1000, height: 760 });
  assert(await page.locator("#send").isVisible());
  await page.screenshot({ path: "/tmp/local-api-compact.png" });
  await page.locator('[data-page="docs"]').click();
  await page.locator("#new-document").click();
  await page.locator("#document-title").fill("本地文档测试");
  await page.locator("#document-content").fill("# 文档\n\n保存在本地。");
  await page.locator("#dialog-save").click();
  await page
    .getByRole("heading", { name: "本地文档测试", exact: true })
    .waitFor();
  await saveAndWait();
  if (!(await page.locator("#new-folder").isVisible()))
    await page.locator(".tree-create summary").click();
  await page.locator("#new-folder").click();
  await page.locator("#folder-name").fill("账户服务");
  await page.locator("#dialog-save").click();
  await saveAndWait();
  await page.reload();
  await page.locator("#project-select").waitFor();
  assert(await page.locator('[data-edit-folder="账户服务"]').isVisible());
  // A real save response arriving late must not erase a subsequent local edit.
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const seen = new Promise((resolve) => {
    started = resolve;
  });
  let intercepted = false;
  await page.route("**/api/projects/*", async (route) => {
    if (route.request().method() === "PUT" && !intercepted) {
      intercepted = true;
      started();
      await gate;
    }
    await route.continue();
  });
  const pendingSave = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" && response.status() === 200,
  );
  await page.locator("#save-project").click();
  await seen;
  if (!(await page.locator("#new-folder").isVisible()))
    await page.locator(".tree-create summary").click();
  await page.locator("#new-folder").click();
  await page.locator("#folder-name").fill("并发保存保护");
  await page.locator("#dialog-save").click();
  release();
  await pendingSave;
  await page.locator("#save-project").waitFor({ state: "visible" });
  await page.unroute("**/api/projects/*");
  await page
    .locator("#saved-state")
    .getByText("● 未保存", { exact: true })
    .waitFor();
  await saveAndWait();
  await page.reload();
  await page.locator('[data-edit-folder="并发保存保护"]').waitFor();
  await page.locator('[data-page="apis"]').click();
  await page.locator('[data-param="auth"]').click();
  await page.locator("#auth-type").selectOption("oauth2");
  await page.locator('[data-auth="tokenEndpoint"]').fill(fixtureURL + "/token");
  await page.locator('[data-auth="clientId"]').fill("ui-client");
  await page.locator('[data-auth="clientSecret"]').fill("fixture-only");
  await page.locator("#oauth-get").click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-auth="token"]')?.value ===
      "ui-fixture-token",
  );
  await saveAndWait();
  await page.locator(".tree-create summary").click();
  await page.locator('[data-page="protocols"]').click();
  await page.locator("#protocol-url").fill(fixtureURL + "/sse");
  await page.locator("#protocol-name").fill("Saved SSE fixture");
  await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.status() === 200,
    ),
    page.locator("#save-protocol").click(),
  ]);
  await page.locator("[data-protocol-id]").waitFor();
  await page.locator("#tree-type").selectOption("sse");
  assert.equal(await page.locator("[data-request]").count(), 0);
  await page.locator("[data-protocol-id]").click();
  assert.equal(
    await page.locator("#protocol-url").inputValue(),
    fixtureURL + "/sse",
  );
  await page.locator("#tree-type").selectOption("all");
  await page.locator("#session-connect").click();
  await page
    .locator("#session-events")
    .getByText("ui-stream-fixture", { exact: false })
    .waitFor();
  await page.locator("#session-stop").click();
  await page.getByText("closed", { exact: true }).waitFor();
  await page.locator('.rail [data-page="settings"]').click();
  await page.locator('[data-settings-anchor="settings-mcp"]').click();
  await page.screenshot({ path: "/tmp/local-api-mcp-settings.png" });
  await page.locator("#mcp-config").click();
  await page.locator("#mcp-enabled").check();
  await page.locator("[data-mcp-project]").first().check();
  await page.locator("#dialog-save").click();
  await page
    .locator("#dialog-title")
    .getByText("MCP 连接配置", { exact: true })
    .waitFor();
  await page.locator('[data-mcp-client="Codex"]').click();
  assert(
    (await page.locator("#mcp-client-code").innerText()).includes(
      "[mcp_servers.localapi]",
    ),
  );
  await page.locator('[data-mcp-client="VS Code"]').click();
  assert(
    JSON.parse(await page.locator("#mcp-client-code").innerText()).servers
      .localapi,
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator("#mcp-config").click();
  assert(await page.locator("#mcp-enabled").isChecked());
  await page.locator("#mcp-enabled").uncheck();
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-page="apis"]').click();
  const oauthPreviousURL = await page.locator("#url").inputValue();
  await page.locator("#url").fill(fixtureURL + "/auth");
  await page.locator('[data-param="auth"]').click();
  await page.locator("#auth-type").selectOption("oauth1");
  await page.locator('[data-auth="consumerKey"]').fill("fixture-consumer");
  await page.locator('[data-auth="consumerSecret"]').fill("fixture-secret");
  const oauth1Response = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const oauth1Result = await (await oauth1Response).json();
  assert.match(JSON.parse(oauth1Result.body).authorization, /^OAuth /);
  assert(
    !JSON.parse(oauth1Result.body).authorization.includes("fixture-secret"),
  );
  await page.locator('[data-auth="signatureMethod"]').selectOption("RSA-SHA1");
  await page
    .locator('[data-auth="privateKey"]')
    .fill(
      await readFile(
        new URL("./fixtures/localhost.key", import.meta.url),
        "utf8",
      ),
    );
  const rsaResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const rsaResult = await (await rsaResponse).json();
  assert.equal(rsaResult.status, 200, JSON.stringify(rsaResult));
  assert.match(
    JSON.parse(rsaResult.body).authorization,
    /oauth_signature_method="RSA-SHA1"/,
  );
  assert(!rsaResult.body.includes("PRIVATE KEY"));
  await page.locator('[data-auth="privateKey"]').fill("");
  await page.locator("#auth-type").selectOption("aws");
  for (const [key, value] of Object.entries({
    accessKey: "fixture-access",
    secretKey: "fixture-aws-secret",
    region: "us-east-1",
    service: "execute-api",
  }))
    await page.locator('[data-auth="' + key + '"]').fill(value);
  const awsResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const awsResult = await (await awsResponse).json();
  assert.match(JSON.parse(awsResult.body).authorization, /^AWS4-HMAC-SHA256 /);
  assert(
    !JSON.parse(awsResult.body).authorization.includes("fixture-aws-secret"),
  );
  await page.locator("#auth-type").selectOption("hawk");
  await page.locator('[data-auth="id"]').fill("hawk-fixture");
  await page.locator('[data-auth="key"]').fill("hawk-fixture-secret");
  const hawkResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const hawkResult = await (await hawkResponse).json();
  assert.match(JSON.parse(hawkResult.body).authorization, /^Hawk /);
  assert(
    !JSON.parse(hawkResult.body).authorization.includes("hawk-fixture-secret"),
  );
  await page.locator("#auth-type").selectOption("edgegrid");
  for (const [key, value] of Object.entries({
    clientToken: "fixture-client",
    clientSecret: "fixture-edgegrid-secret",
    accessToken: "fixture-access",
  }))
    await page.locator('[data-auth="' + key + '"]').fill(value);
  let releaseAuthRefresh, authRefreshReady;
  const authRefreshGate = new Promise((resolve) => {
    releaseAuthRefresh = resolve;
  });
  const authRefreshStarted = new Promise((resolve) => {
    authRefreshReady = resolve;
  });
  const delayedAuthRefresh = async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const fetched = await route.fetch();
    authRefreshReady();
    await authRefreshGate;
    await route.fulfill({ response: fetched });
  };
  await page.route("**/api/projects/*", delayedAuthRefresh);
  const edgegridResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const edgegridResult = await (await edgegridResponse).json();
  assert.match(
    JSON.parse(edgegridResult.body).authorization,
    /^EG1-HMAC-SHA256 /,
  );
  assert(
    !JSON.parse(edgegridResult.body).authorization.includes(
      "fixture-edgegrid-secret",
    ),
  );
  await authRefreshStarted;
  await page.locator("#url").evaluate((input) => {
    input.focus();
    input.select();
  });
  releaseAuthRefresh();
  await page.waitForFunction(() => !document.querySelector("#send")?.disabled);
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "url",
    "response refresh preserves the actively edited field",
  );
  assert.equal(
    await page
      .locator("#url")
      .evaluate((input) => input.selectionEnd - input.selectionStart),
    await page
      .locator("#url")
      .inputValue()
      .then((value) => value.length),
    "response refresh preserves text selection",
  );
  await page.unroute("**/api/projects/*", delayedAuthRefresh);
  await page.locator("#url").fill(ntlmFixture.url);
  await page.locator("#auth-type").selectOption("ntlm");
  await page.locator('[data-auth="username"]').fill("User");
  await page.locator('[data-auth="password"]').fill("Password");
  await page.locator('[data-auth="domain"]').fill("Domain");
  await page.locator('[data-auth="workstation"]').fill("COMPUTER");
  const ntlmResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const ntlmResult = await (await ntlmResponse).json();
  assert.equal(ntlmResult.status, 200, JSON.stringify(ntlmResult));
  assert.equal(JSON.parse(ntlmResult.body).ntlm, true);
  assert.equal(ntlmFixture.stats.sockets.size, 1);
  await page.locator("#toast").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".form-grid .notice").count(), 0);
  const ntlmUsernameBox = await page
    .locator('[data-auth="username"]')
    .boundingBox();
  assert(
    ntlmUsernameBox.width >= 200,
    "NTLM inputs retain the full-width form column",
  );
  await page.locator('[data-auth="username"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/local-api-ntlm.png" });
  await page.locator("#auth-type").selectOption("none");
  await page.locator("#url").fill(oauthPreviousURL);
  await page.locator('.rail [data-page="settings"]').click();
  await page.locator('[data-settings-anchor="resource-functions"]').click();
  await page.locator("#new-function").click();
  await page.locator("#function-name").fill("double");
  await page.locator("#function-body").fill("return text * 2;");
  await page.locator("#function-input").fill("3");
  await page.locator("#dialog-save").click();
  assert(
    await page.locator("#dialog").isVisible(),
    "untested function cannot be saved",
  );
  await page.locator("#test-function").click();
  await page
    .locator("#function-result")
    .getByText("6", { exact: true })
    .waitFor();
  const functionResultBox = await page
    .locator("#function-result")
    .boundingBox();
  const functionDialogBox = await page.locator("#dialog-content").boundingBox();
  assert(
    functionResultBox.y + functionResultBox.height <=
      functionDialogBox.y + functionDialogBox.height,
    "function preview result must be visible without scrolling",
  );
  assert(
    (await page.locator("#function-input").boundingBox()).height <= 90,
    "test input must override generic modal textarea minimum",
  );
  await page.screenshot({ path: "/tmp/local-api-function-validation.png" });
  await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.status() === 200,
    ),
    page.locator("#dialog-save").click(),
  ]);
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-settings-anchor="resource-functions"]').click();
  assert(
    (await page.locator("#resource-functions").innerText()).includes("double"),
  );
  await page.locator("[data-edit-function]").first().click();
  assert(await page.locator("#function-name").isDisabled());
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.locator('[data-settings-anchor="settings-mock-fields"]').click();
  await page.locator("#new-mock-field").click();
  await page.locator("#mock-field-name").fill("姓名字段");
  await page.locator("#mock-field-pattern").fill("{name,*_name}");
  await page.locator("#mock-field-value").fill("@cname()");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator("#mock-builtins").check();
  await page.locator("#mock-seed").fill("42");
  await saveAndWait();
  await page.screenshot({ path: "/tmp/local-api-mock-fields.png" });
  await page.locator('[data-settings-anchor="resource-statusCodes"]').click();
  await page.locator("#new-error-code").click();
  await page.locator("#error-code-value").fill("AUTH_EXPIRED");
  await page.locator("#error-code-label").fill("登录过期");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator("#bulk-error-codes").click();
  await page
    .locator("#error-codes-source")
    .fill("AUTH_EXPIRED: 登录过期\n0: 业务成功\n10001: 余额不足");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-error-codes.png" });
  await page.locator('[data-page="docs"]').click();
  await page
    .locator(".error-code-document")
    .getByText("AUTH_EXPIRED", { exact: true })
    .waitFor();
  await page
    .locator(".error-code-document")
    .getByText("余额不足", { exact: true })
    .waitFor();
  await page.locator('.rail [data-page="settings"]').click();
  await page.locator('[data-settings-anchor="resource-attributes"]').click();
  await page.locator("#new-attribute").click();
  await page.locator("#attribute-key").fill("priority");
  await page.locator("#attribute-label").fill("优先级");
  await page.locator("#attribute-type").selectOption("select");
  await page.locator("#attribute-options").fill("low\nhigh");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-edit-resource="attributes"]').click();
  await page.locator("#modal-json").fill(
    JSON.stringify([
      {
        key: "priority",
        label: "优先级",
        type: "select",
        options: ["low", "high"],
      },
      {
        key: "many",
        label: "模块",
        type: "multiselect",
        options: ["api", "ui"],
      },
      { key: "due", label: "日期", type: "date" },
      { key: "home", label: "链接", type: "url" },
      { key: "mail", label: "邮箱", type: "email" },
      { key: "privateNote", label: "内部备注", type: "string" },
      { key: "count", label: "数量", type: "number" },
      { key: "enabled", label: "启用", type: "boolean" },
    ]),
  );
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-settings-anchor="resource-statuses"]').click();
  await page.locator('[data-edit-resource="statuses"]').click();
  await page
    .locator("#modal-json")
    .fill('[{"id":"ready","name":"已完成","color":"#0f766e"}]');
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-page="apis"]').click();
  await page.locator('[data-mode="design"]').click();
  await page.locator('[data-attribute="priority"]').selectOption("high");
  await page.locator('[data-attribute="many"]').selectOption(["api", "ui"]);
  await page.locator('[data-attribute="due"]').fill("2026-10-18");
  await page
    .locator('[data-attribute="home"]')
    .fill("https://example.test/private");
  await page.locator('[data-attribute="mail"]').fill("api@example.test");
  await page.locator('[data-attribute="privateNote"]').fill("internal-only");
  await page.locator('[data-attribute="count"]').fill("0");
  await page.locator('[data-attribute="enabled"]').check();
  await page.locator('[data-attribute="enabled"]').uncheck();
  await saveAndWait();
  await page.locator('[data-page="docs"]').click();
  await page.locator("[data-edit-document]").first().click();
  await page
    .locator("#document-content")
    .fill(
      "# 文档\n\n**保存在本地。**\n\n| 字段 | 类型 |\n| --- | --- |\n| id | number |",
    );
  await page.locator("#document-preview table").waitFor();
  assert.equal(
    await page.locator("#document-preview strong").innerText(),
    "保存在本地。",
  );
  await page.locator("#document-status").selectOption("ready");
  await page.locator('[data-doc-attribute="mail"]').fill("doc@example.test");
  await page.locator("#dialog-save").click();
  await page.locator("#app").getByText("已完成", { exact: true }).waitFor();
  await page.locator("#app .markdown-content table").waitFor();
  await page.screenshot({ path: "/tmp/local-api-markdown-document.png" });
  await saveAndWait();
  await page.locator('.rail [data-page="settings"]').click();
  await page.locator('[data-settings-anchor="settings-environments"]').click();
  await page.locator("[data-debug-env]").first().click();
  const debugValues = JSON.parse(
    await page.locator("#modal-json").inputValue(),
  );
  await page
    .locator("#modal-json")
    .fill(JSON.stringify({ ...debugValues, uiRuntime: "temporary" }));
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator("[data-debug-env]").first().click();
  assert.equal(
    JSON.parse(await page.locator("#modal-json").inputValue()).uiRuntime,
    "temporary",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator("#edit-globals").click();
  await page.locator("#modal-json").fill('{"tenant":"ui-global"}');
  await page.locator("#dialog-save").click();
  await page.locator("#add-service").click();
  await page.locator("#service-name").fill("UI Backend");
  await page.locator("[data-service-url]").first().fill(fixtureURL);
  await page.locator("#dialog-save").click();
  await saveAndWait();
  await page.locator('[data-page="apis"]').click();
  await page.locator('[data-edit-folder="示例接口"]').click();
  await page.locator("#folder-service").selectOption({ label: "UI Backend" });
  await page.locator("#dialog-save").click();
  await saveAndWait();
  await page.reload();
  await page.locator('[data-edit-folder="示例接口"]').click();
  assert.equal(
    await page.locator("#folder-service option:checked").innerText(),
    "UI Backend",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator('.rail [data-page="settings"]').click();
  await page.locator('[data-settings-anchor="settings-environments"]').click();
  await page.locator("[data-edit-service]").waitFor();
  assert((await page.locator("body").innerText()).includes("ui-global"));
  await page.screenshot({ path: "/tmp/local-api-settings.png" });
  await page.locator('[data-page="plans"]').click();
  await page.locator("[data-plan]").first().click();
  await page
    .locator("#plan-description")
    .fill("Visible deterministic verification plan");
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith("/plans") &&
        r.status() === 200,
    ),
    page.locator("#save-plan-details").click(),
  ]);
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith("/plans") &&
        r.status() === 200,
    ),
    page.locator("#plan-status-policy").selectOption("assertions"),
  ]);
  await page.reload();
  await page.locator('[data-page="plans"]').click();
  await page.locator("[data-plan]").first().click();
  assert.equal(
    await page.locator("#plan-status-policy").inputValue(),
    "assertions",
  );
  assert.equal(
    await page.locator("#plan-description").inputValue(),
    "Visible deterministic verification plan",
  );
  await page.locator('[data-page="apis"]').click();
  await page.locator('[data-mode="cases"]').click();
  await page.locator("#new-interface-case").click();
  await page.locator("#case-name").fill("Independent persisted case");
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith("/cases") &&
        r.status() === 200,
    ),
    page.locator("#dialog-save").click(),
  ]);
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.reload();
  await page.locator('[data-mode="cases"]').click();
  await page.getByText("Independent persisted case", { exact: true }).waitFor();
  await page.locator("[data-run-case]").click();
  await page
    .locator(".page pre")
    .getByText('"outcome": "passed"', { exact: false })
    .waitFor();
  await page.screenshot({ path: "/tmp/local-api-cases.png" });
  await page.locator('[data-mode="mock"]').click();
  await page.locator("#edit-mock-rules").click();
  await page.locator("#modal-json").fill(
    JSON.stringify([
      {
        name: "UI smart rule",
        conditions: [{ target: "query.scenario", op: "eq", value: "smart" }],
        response: {
          status: 201,
          body: '{"smart":true}',
          headers: { "content-type": "application/json" },
        },
      },
    ]),
  );
  await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.status() === 200,
    ),
    page.locator("#dialog-save").click(),
  ]);
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator("#use-mock").click();
  const mockURL = await page.locator("#url").inputValue();
  await page.locator("#url").fill(mockURL + "?scenario=smart");
  await page.locator("#send").click();
  await page
    .locator(".response-body")
    .getByText('"smart": true', { exact: false })
    .waitFor();
  await saveAndWait();

  await page.locator("#share-api").click();
  assert.equal(await page.locator("[data-share-attribute]:checked").count(), 0);
  await page.locator('[data-share-attribute][value="mail"]').check();
  await page.locator('[data-share-attribute][value="priority"]').check();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#dialog-save").click();
  const documentDownload = await downloadPromise;
  const documentText = await readFile(await documentDownload.path(), "utf8");
  assert(documentText.includes("Content-Security-Policy"));
  assert(documentText.includes("响应定义"));
  assert(documentText.includes("AUTH_EXPIRED"));
  assert(documentText.includes("api@example.test"));
  assert(!documentText.includes("internal-only"));
  assert(!documentText.includes("https://example.test/private"));
  await page.locator('[data-page="dictionary"]').click();
  await page.locator("#import-parameter-dictionary").click();
  await page.locator("#dictionary-source").fill("customerId: 客户编号");
  await page.locator("#dialog-save").click();
  await page
    .locator("#dialog-title")
    .getByText("确认字典导入", { exact: true })
    .waitFor();
  await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.status() === 200,
    ),
    page.locator("#dialog-save").click(),
  ]);
  await page.reload();
  await page.locator('[data-page="dictionary"]').click();
  await page.getByText("customerId", { exact: true }).waitFor();
  await page.locator('[data-page="apis"]').click();
  await page.locator('[data-param="query"]').click();
  await page.locator('[data-add-pair="query"]').click();
  await page.locator('[data-dictionary-pair="query:0"]').click();
  await page.locator("#dialog-save").click();
  assert.equal(
    await page.locator('[data-pair="query:0:key"]').inputValue(),
    "customerId",
  );
  await page.locator('[data-dynamic-pair="query:0"]').click();
  await page.locator("#dynamic-source").selectOption("mock");
  await page.locator("#dynamic-value").fill("@integer(7,7)");
  await page.getByText("Mock类型与种子", { exact: true }).click();
  await page.locator("#dynamic-mock-type").selectOption("integer");
  await page.locator("#dynamic-seed").fill("42");
  await page.locator("#dynamic-functions").fill("double");
  await page.locator("#dynamic-preview").click();
  await page.waitForFunction(
    () => document.querySelector("#dynamic-result").textContent === "14",
  );
  await page.locator("#dialog-save").click();
  const dynamicResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const dynamicResult = await (await dynamicResponse).json();
  assert.equal(
    new URL(dynamicResult.request.url).searchParams.get("customerId"),
    "14",
  );
  await page.locator('[data-param="body"]').click();
  await page.locator("#body-code").fill('{"existing":true}');
  await page.locator("#toggle-parameter-helper").click();
  await page
    .locator("[data-insert-dictionary]")
    .filter({ hasText: "customerId" })
    .click();
  assert.deepEqual(JSON.parse(await page.locator("#body-code").inputValue()), {
    existing: true,
    customerId: "",
  });
  await page.locator('[data-mode="design"]').click();
  await page.locator("#schema").fill(
    JSON.stringify({
      type: "object",
      properties: {
        n: { type: "integer", minimum: 2, maximum: 4 },
        label: { type: "string", minLength: 3 },
        user_name: { type: "string" },
      },
      "x-data": { $ref: "#/properties/label" },
      $defs: { SharedLabel: { type: "string", minLength: 3 } },
    }),
  );
  const schemaBeforeVisual = await page.locator("#schema").inputValue();
  await page.locator("#visual-schema").click();
  await page.locator('[data-schema-add="0"]').click();
  await page.locator("[data-schema-name]").fill("discarded");
  await page.locator("[data-schema-apply]").click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(await page.locator("#schema").inputValue(), schemaBeforeVisual);
  await page.locator("#visual-schema").click();
  assert(
    !(await page.locator(".schema-tree").innerText()).includes("discarded"),
  );
  await page.locator('[data-schema-edit="2"]').click();
  await page.locator("[data-schema-name]").fill("label-renamed");
  await page.locator("[data-schema-apply]").click();
  assert(
    (await page.locator(".schema-tree").innerText()).includes("label-renamed"),
  );
  await page.locator('[data-schema-edit="2"]').click();
  await page.locator("[data-schema-name]").fill("label");
  await page.locator("[data-schema-apply]").click();
  await page.locator('[data-schema-reference-edit="2"]').click();
  await page.locator("[data-schema-reference]").fill("#/$defs/Missing");
  await page.locator("[data-schema-apply]").click();
  await page
    .locator(".schema-error")
    .getByText("引用目标不存在", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#schema").inputValue(), schemaBeforeVisual);
  await page.locator("[data-schema-reference]").fill("#/$defs/SharedLabel");
  await page.screenshot({ path: "/tmp/local-api-schema-reference.png" });
  await page.locator("[data-schema-apply]").click();
  await page.locator('[data-schema-edit="1"]').click();
  await page.locator("[data-schema-description]").fill("数量范围保留");
  await page.locator(".schema-constraints > summary").click();
  await page.locator('[data-schema-constraint="minimum"]').fill("5");
  await page.locator("[data-schema-apply]").click();
  await page
    .locator(".schema-error")
    .getByText("约束下限不能大于上限", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#schema").inputValue(), schemaBeforeVisual);
  await page.locator('[data-schema-constraint="minimum"]').fill("1");
  await page.locator('[data-schema-constraint="enum"]').fill("[1,2,3,4]");
  const constraintBox = await page
    .locator(".schema-constraint-grid")
    .boundingBox();
  assert(
    constraintBox.height <= 200,
    "constraint inputs must use a bounded inner viewport",
  );
  const constraintFooter = await page.locator("#dialog-save").boundingBox();
  const constraintEnum = await page
    .locator('[data-schema-constraint="enum"]')
    .boundingBox();
  assert(
    constraintEnum.y + constraintEnum.height <= constraintFooter.y,
    "enum field must not overlap the save footer",
  );
  await page.screenshot({ path: "/tmp/local-api-schema-constraints.png" });
  await page.locator(".schema-constraints > summary").click();
  await page.locator("[data-schema-required]").check();
  await page.locator("[data-schema-example]").fill("2");
  await page.locator("[data-schema-apply]").click();
  await page.locator('[data-schema-add="0"]').click();
  await page.locator("[data-schema-name]").fill("flag");
  await page.locator("[data-schema-apply]").click();
  await page.locator('[data-schema-edit="4"]').click();
  await page.locator("[data-schema-type]").selectOption("boolean");
  await page.locator("[data-schema-example]").fill("{");
  await page.locator("#dialog-save").click();
  await page
    .getByText("示例必须为有效JSON，字符串请加双引号", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#dialog").isVisible(), true);
  await page.locator("[data-schema-example]").fill("false");
  await page.screenshot({ path: "/tmp/local-api-schema-editor.png" });
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  const visualSchema = JSON.parse(await page.locator("#schema").inputValue());
  assert.deepEqual(visualSchema["x-data"], { $ref: "#/properties/label" });
  assert.equal(visualSchema.properties.label.$ref, "#/$defs/SharedLabel");
  assert.equal(visualSchema.properties.label.minLength, 3);
  assert.equal(visualSchema.properties.n.minimum, 1);
  assert.deepEqual(visualSchema.properties.n.enum, [1, 2, 3, 4]);
  assert.equal(visualSchema.properties.n.maximum, 4);
  assert(visualSchema.required.includes("n"));
  assert.equal(visualSchema.properties.flag.example, false);
  await saveAndWait("#save");
  const schemaProject = await app.store.get(
    await page.locator("#project-select").inputValue(),
  );
  const schemaRequestId = await page
    .locator(".tree-item.active")
    .getAttribute("data-request");
  assert.equal(
    schemaProject.requests.find((item) => item.id === schemaRequestId).schema
      .properties.flag.example,
    false,
  );
  assert.equal(
    schemaProject.requests.find((item) => item.id === schemaRequestId).schema
      .properties.label.$ref,
    "#/$defs/SharedLabel",
  );
  const originalResponse = {
    status: "200",
    description: "retained",
    headers: { "x-trace": { schema: { type: "string" } } },
    content: { "text/plain": { schema: { type: "string" }, example: "keep" } },
  };
  await page
    .locator("#response-definitions")
    .fill(JSON.stringify([originalResponse]));
  await page.locator("#new-response-schema").click();
  await page.locator("#schema-response-status").fill("201");
  await page.locator("#schema-response-description").fill("Created schema");
  await page.locator('[data-schema-add="0"]').click();
  await page.locator("[data-schema-name]").fill("ok");
  await page.locator("[data-schema-apply]").click();
  await page.locator('[data-schema-edit="1"]').click();
  await page.locator("[data-schema-type]").selectOption("boolean");
  await page.locator("[data-schema-example]").fill("false");
  await page.locator("#schema-response-status").fill("200");
  await page.locator("#dialog-save").click();
  await page
    .getByText("此响应状态已存在，请编辑已有响应", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#dialog").isVisible(), true);
  await page.locator("[data-schema-example]").fill("true");
  await page.locator("#schema-response-status").fill("201");
  const responseApplyBox = await page
    .locator("[data-schema-apply]")
    .boundingBox();
  const responseContentBox = await page
    .locator("#dialog-content")
    .boundingBox();
  assert(
    responseApplyBox.y + responseApplyBox.height <=
      responseContentBox.y + responseContentBox.height,
    "pending response field actions must remain above the footer",
  );
  await page.screenshot({ path: "/tmp/local-api-response-schema.png" });
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  const responseDefinitions = JSON.parse(
    await page.locator("#response-definitions").inputValue(),
  );
  assert.deepEqual(responseDefinitions[0], originalResponse);
  assert.equal(
    responseDefinitions[1].content["application/json"].schema.properties.ok
      .example,
    true,
  );
  await saveAndWait("#save");
  const responseProject = await app.store.get(
    await page.locator("#project-select").inputValue(),
  );
  const responseRequest = responseProject.requests.find(
    (item) => item.id === schemaRequestId,
  );
  const exportedResponse = exportOpenAPI({
    name: "visual response",
    requests: [responseRequest],
  });
  const exportedOperation = Object.values(exportedResponse.paths)[0][
    responseRequest.method.toLowerCase()
  ];
  assert.equal(
    exportedOperation.responses["201"].content["application/json"].schema
      .properties.ok.example,
    true,
  );

  const tupleSchema = JSON.parse(await page.locator("#schema").inputValue());
  tupleSchema.properties.ordered = {
    type: "array",
    prefixItems: [{ const: 42 }, { const: false }],
    items: false,
  };
  await page.locator("#schema").fill(JSON.stringify(tupleSchema));
  await page.locator('[data-mode="debug"]').click();
  await page.locator('[data-param="body"]').click();
  await page.locator("#generate-body").click();
  await page.waitForFunction(() => {
    try {
      return (
        JSON.parse(document.querySelector("#body-code").value).label === "xxx"
      );
    } catch {
      return false;
    }
  });
  const generatedBody = JSON.parse(
    await page.locator("#body-code").inputValue(),
  );
  assert.equal(generatedBody.n, 2);
  assert.deepEqual(generatedBody.ordered, [42, false]);
  assert.equal(generatedBody.flag, false);
  assert.equal(generatedBody.label, "xxx");
  assert.match(generatedBody.user_name, /^[\u4e00-\u9fff]{2,3}$/);
  await page.locator("#body-code").fill("");
  if (!(await page.locator("#new-body-dynamic").isVisible()))
    await page.locator("#toggle-parameter-helper").click();
  await page.locator("#new-body-dynamic").click();
  await page.locator("#dynamic-value").fill('{"n":7,"literal":"{{keep}}"}');
  await page.locator("#dialog-save").click();
  assert.match(await page.locator("#body-code").inputValue(), /\{\{@value:/);
  const bodyDynamicResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const bodyDynamicResult = await (await bodyDynamicResponse).json();
  assert.deepEqual(JSON.parse(bodyDynamicResult.request.body), {
    n: 7,
    literal: "{{keep}}",
  });
  await page.locator("[data-edit-body-dynamic]").click();
  await page.locator("#dynamic-remove").click();
  assert.equal(await page.locator("#body-code").inputValue(), "");
  await page.locator("#body-code").fill(JSON.stringify(generatedBody));

  await page.locator('[data-param="extract"]').click();
  await page.locator("#add-extract").click();
  await page.locator('[data-extract="0:name"]').fill("elapsed");
  await page.locator('[data-extract="0:source"]').selectOption("duration");
  await page.locator("#add-extract").click();
  await page.locator('[data-extract="1:name"]').fill("wholeText");
  await page.locator('[data-extract="1:source"]').selectOption("regex");
  await page.locator('[data-extract="1:path"]').fill("/(.+)/");
  await page.locator('[data-extract="1:group"]').fill("1");
  await saveAndWait();
  await page.reload();
  await page.locator('[data-param="extract"]').click();
  assert.equal(
    await page.locator('[data-extract="0:source"]').inputValue(),
    "duration",
  );
  assert.equal(
    await page.locator('[data-extract="1:source"]').inputValue(),
    "regex",
  );
  assert.equal(
    await page.locator('[data-extract="1:group"]').inputValue(),
    "1",
  );
  await page.locator("#import").click();
  await page
    .locator("#import-file")
    .setInputFiles(
      fileURLToPath(
        new URL("./fixtures/apipost-converter-0.1.89.json", import.meta.url),
      ),
    );
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page
    .locator(".import-notes")
    .getByText("原URL未声明协议，已采用HTTPS；发送前请确认。", { exact: false })
    .waitFor();
  assert.equal(
    await page.locator("#url").inputValue(),
    "https://fixture.example.test/v1/users/{id}",
  );
  assert.equal(await page.locator("#folder").inputValue(), "Users");
  await page.screenshot({ path: "/tmp/local-api-apipost-import.png" });
  const modern = modernApipostFixture();
  modern.global.envs[0].server_list[0].uri = fixtureURL;
  modern.apis[1].url = "/auth";
  modern.apis[1].request.query.parameter = [];
  modern.models = [
    {
      model_id: "browser-model",
      model_type: "model",
      parent_id: "0",
      name: "BrowserModel",
      schema: { type: "object", properties: { id: { const: 7 } } },
    },
  ];
  modern.apis[1].request.body.raw_schema = {
    $ref: "#/definitions/browser-model",
  };
  await page.locator("#import").click();
  await page.locator("#import-text").fill(JSON.stringify(modern));
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page
    .locator(".import-notes")
    .getByText("现代Apipost JSON有限互操作", { exact: false })
    .waitFor();
  assert.equal(await page.locator("#url").inputValue(), "/auth");
  await page.locator("#env").selectOption({ label: "Imported" });
  await page.locator('[data-mode="debug"]').click();
  const modernResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const modernResult = await (await modernResponse).json();
  assert.equal(modernResult.status, 200, JSON.stringify(modernResult));
  assert.equal(modernResult.request.headers["x-test"], "current");
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-apipost-modern.png" });
  await page.locator('[data-page="dictionary"]').click();
  await page
    .getByText("Fictional modern export / BrowserModel", { exact: true })
    .waitFor();
  await page.screenshot({ path: "/tmp/local-api-apipost-model.png" });
  const h2Project = await app.store.create("HTTP2 browser fixture");
  h2Project.requests = [
    normalizeRequest({
      name: "HTTP2 proxy UI",
      url: "http://127.0.0.1:" + h2Fixture.address().port + "/h2",
      method: "POST",
      bodyType: "json",
      body: '{"via":"h2-ui"}',
    }),
  ];
  await app.store.save(h2Project);
  await page.reload();
  await page.locator("#project-select").selectOption(h2Project.id);
  await page.waitForFunction(
    () => document.querySelector("#request-name")?.value === "HTTP2 proxy UI",
  );
  await page.locator("#http-version").selectOption("2");
  await page.locator('[data-mode="design"]').click();
  await page
    .locator("#request-proxy")
    .fill("http://127.0.0.1:" + h2Proxy.address().port);
  assert.equal(await page.locator('[data-tls="proxyCa"]').count(), 1);
  await page.locator('[data-mode="debug"]').click();
  const h2Response = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const h2Payload = await (await h2Response).json();
  assert.equal(h2Payload.outcome, "passed", JSON.stringify(h2Payload));
  assert.deepEqual(JSON.parse(h2Payload.body), {
    protocol: "h2",
    method: "POST",
    body: '{"via":"h2-ui"}',
  });
  assert.equal(h2Connections, 1);
  await page.waitForFunction(() =>
    document.querySelector(".response .metrics")?.textContent.includes("200"),
  );
  const responseGeometry = await page
    .locator(".response-top")
    .evaluate((top) => {
      const tabs = top.querySelector(".response-tabs");
      const metrics = top.querySelector(".metrics");
      const status = metrics.querySelector("span");
      const a = tabs.getBoundingClientRect(),
        b = metrics.getBoundingClientRect();
      const statusBox = status.getBoundingClientRect();
      const center = document.elementFromPoint(
        statusBox.left + statusBox.width / 2,
        statusBox.top + statusBox.height / 2,
      );
      return {
        separate: a.right <= b.left + 1,
        inside: b.right <= top.getBoundingClientRect().right + 1,
        complete: metrics.scrollWidth <= metrics.clientWidth + 1,
        statusUncovered: center === status || status.contains(center),
        scrollable: tabs.scrollWidth > tabs.clientWidth,
      };
    });
  assert.deepEqual(responseGeometry, {
    separate: true,
    inside: true,
    complete: true,
    statusUncovered: true,
    scrollable: true,
  });
  await page.locator('[data-response="logs"]').click();
  assert.match(
    await page.locator('[data-response="logs"]').getAttribute("class"),
    /active/,
  );
  await page.locator('[data-response="body"]').click();
  await page.screenshot({ path: "/tmp/local-api-http2-proxy.png" });
  await saveAndWait("#save");
  await page.locator("#curl").click();
  await page.locator("#curl-output").waitFor();
  assert.match(
    await page.locator("#curl-output").inputValue(),
    /--http2-prior-knowledge/,
  );
  assert.match(
    await page.locator("#curl-output").inputValue(),
    /--proxytunnel/,
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const observedProject = await app.store.create("stdio UI evidence");
  observedProject.plans = [
    snapshotPlan({
      name: "observable stdio",
      steps: [
        { request: { url: fixtureURL + "/auth" } },
        { request: { url: fixtureURL + "/slow-mcp" } },
      ],
    }),
  ];
  await app.store.save(observedProject);
  mcpGate = new Promise((resolve) => {
    releaseMCP = resolve;
  });
  await page.locator("#request-name").fill("未保存草稿在MCP进度轮询后保留");
  stdioChild = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../src/mcp.mjs", import.meta.url)),
      "--project",
      observedProject.id,
      "--write",
      "--execute",
    ],
    {
      env: { ...process.env, LOCAL_API_DATA: root },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  stdioChild.stderr.on("data", () => {});
  const stdioLines = readline.createInterface({ input: stdioChild.stdout }),
    stdioAnswer = once(stdioLines, "line");
  stdioChild.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "localapi_run_plan",
        arguments: {
          projectId: observedProject.id,
          planId: observedProject.plans[0].id,
        },
      },
    }) + "\n",
  );
  await page
    .locator("#mcp-status")
    .getByText("MCP · 1 个任务运行中", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator("#request-name").inputValue(),
    "未保存草稿在MCP进度轮询后保留",
  );
  await page.screenshot({ path: "/tmp/local-api-stdio-progress.png" });
  releaseMCP();
  const [stdioLine] = await stdioAnswer;
  assert.equal(
    JSON.parse(JSON.parse(stdioLine).result.content[0].text).status,
    "passed",
  );
  await page.waitForFunction(
    () => !document.querySelector("#mcp-status").textContent.includes("运行中"),
  );
  assert.equal(
    await page.locator("#request-name").inputValue(),
    "未保存草稿在MCP进度轮询后保留",
  );
  const stdioClosed = once(stdioChild, "close");
  stdioChild.stdin.end();
  await stdioClosed;
  stdioLines.close();
  // Cookie manager: explicit opt-in, edit persistence, stale revision and deletion.
  await page.locator('[data-param="cookies"]').click();
  await page.locator("#cookie-manager").click();
  await page
    .getByRole("button", { name: "开启自动Cookie", exact: true })
    .waitFor();
  await page.locator("#cookie-url").fill(fixtureURL + "/");
  await page
    .locator("#cookie-line")
    .fill("ui-session=fixture-one; Path=/; HttpOnly");
  await page.locator("#cookie-set").click();
  await page
    .locator(".cookie-table")
    .getByText("ui-session", { exact: true })
    .waitFor();
  await page.locator("#cookie-toggle").click();
  await page
    .getByRole("button", { name: "关闭自动Cookie", exact: true })
    .waitFor();
  await page.locator('[data-cookie-edit="0"]').click();
  await page
    .locator("#cookie-line")
    .fill("ui-session=fixture-two; Path=/; HttpOnly");
  await page.locator("#cookie-set").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".cookie-table input")?.value === "fixture-two",
  );
  assert.equal(
    await page.locator(".cookie-table input").getAttribute("type"),
    "password",
  );
  const cookieNoticeBox = await page
    .locator("#dialog-content .notice")
    .boundingBox();
  const cookieContentBox = await page.locator("#dialog-content").boundingBox();
  assert(
    cookieNoticeBox.y >= cookieContentBox.y,
    "Cookie privacy notice must remain visible after save",
  );
  await page.screenshot({ path: "/tmp/local-api-cookie-manager.png" });
  await page.locator("#dialog-save").click();
  await page.locator("#cookie-manager").click();
  await page.locator("#dialog").waitFor({ state: "visible" });
  assert.equal(
    await page.locator(".cookie-table input").inputValue(),
    "fixture-two",
  );
  const { ProjectCookieJar } = await import("../src/cookie-jar.mjs");
  const cookieProject = await app.store.get(
    await page.locator("#project-select").inputValue(),
  );
  const cookieEnvironment = await page.locator("#env").inputValue();
  const concurrentJar = new ProjectCookieJar(
    root,
    cookieProject.id,
    cookieEnvironment,
  );
  await concurrentJar.configure({
    enabled: false,
    expectedRevision: (await concurrentJar.inspect()).revision,
  });
  await page.locator("#cookie-toggle").click();
  await page
    .getByText("Cookie已有其他修改，请重新加载", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#dialog").isVisible(), true);
  await page.locator("#cookie-refresh").click();
  await page
    .getByRole("button", { name: "开启自动Cookie", exact: true })
    .waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('[data-cookie-remove="0"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll("[data-cookie-remove]").length === 0,
  );
  await page.locator("#dialog-save").click();
  // A delayed read from a closed manager must not replace the reopened draft.
  let releaseCookieRead, cookieReadReady;
  const cookieReadGate = new Promise((resolve) => {
    releaseCookieRead = resolve;
  });
  const cookieReady = new Promise((resolve) => {
    cookieReadReady = resolve;
  });
  let holdCookieRead = true;
  const cookieRoute = async (route) => {
    if (!holdCookieRead) return route.continue();
    holdCookieRead = false;
    const response = await route.fetch();
    cookieReadReady();
    await cookieReadGate;
    await route.fulfill({ response });
  };
  await page.route("**/cookies?environmentId=*", cookieRoute);
  await page.locator("#cookie-manager").click();
  await cookieReady;
  await page.locator("#dialog").waitFor({ state: "visible" });
  await page.locator("#dialog-save").click();
  await page.locator("#cookie-manager").click();
  await page.locator("#cookie-toggle").waitFor();
  await page.locator("#cookie-url").fill("https://new-draft.example.test/");
  const lateCookieResponse = page.waitForResponse((r) =>
    r.url().includes("/cookies?environmentId="),
  );
  releaseCookieRead();
  await (await lateCookieResponse).finished();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await page.locator("#cookie-url").inputValue(),
    "https://new-draft.example.test/",
  );
  assert.equal(await page.locator("#dialog").isVisible(), true);
  await page.unroute("**/cookies?environmentId=*", cookieRoute);
  await page.locator("#dialog-save").click();
  await page.locator('.rail [data-page="settings"]').click();
  await page.locator('[data-page="database"]').click();
  await page.locator("#db-type").selectOption("redis");
  assert.equal(await page.locator("#db-path").isVisible(), false);
  assert.equal(await page.locator("#db-params").isVisible(), false);
  await page.locator("#db-host").fill("127.0.0.1");
  await page.locator("#db-port").fill(String(redisFixture.address().port));
  await page.locator("#db-name").fill("0");
  await page.locator("#db-sql").fill('["GET","ui-fixture"]');
  await page.locator("#db-query").click();
  await page
    .locator("#db-result")
    .getByText("redis-ui-fixture", { exact: false })
    .waitFor();
  const databaseResultBox = await page.locator("#db-result").boundingBox();
  assert(
    databaseResultBox.y >= 0 &&
      databaseResultBox.y + databaseResultBox.height <=
        page.viewportSize().height,
    "database result scrolls into view",
  );
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-redis-query.png" });
  let releaseDatabaseReply, databaseReplyReady;
  const databaseGate = new Promise((resolve) => {
    releaseDatabaseReply = resolve;
  });
  const databaseReady = new Promise((resolve) => {
    databaseReplyReady = resolve;
  });
  const delayedDatabaseRoute = async (route) => {
    const response = await route.fetch();
    databaseReplyReady();
    await databaseGate;
    await route.fulfill({ response });
  };
  await page.route("**/api/projects/*/database", delayedDatabaseRoute);
  await page.locator("#db-query").click();
  await databaseReady;
  await page.locator("#db-type").selectOption("mongodb");
  const staleDatabaseResponse = page.waitForResponse((r) =>
    r.url().endsWith("/database"),
  );
  releaseDatabaseReply();
  await (await staleDatabaseResponse).finished();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.unroute("**/api/projects/*/database", delayedDatabaseRoute);
  assert.equal(await page.locator("#db-query").isEnabled(), true);

  assert.equal(await page.locator("#db-auth-source").isVisible(), true);
  assert.equal(await page.locator("#db-params").isVisible(), false);
  assert.equal(await page.locator("#db-result").innerText(), "");
  assert.equal(
    await page.locator("#db-sql").inputValue(),
    '["GET","ui-fixture"]',
    "switching type preserves edited query text",
  );

  await page.locator('.rail [data-page="settings"]').click();
  await page
    .locator('[data-settings-anchor="settings-global-parameters"]')
    .click();
  await page.locator('[data-global-add="headers"]').click();
  await page
    .locator('[data-global-field="headers:0:key"]')
    .fill("X-Global-Fixture");
  await page
    .locator('[data-global-field="headers:0:value"]')
    .fill("shared-value");
  await page.locator('[data-global-add="query"]').click();
  await page.locator('[data-global-field="query:0:key"]').fill("source");
  await page.locator('[data-global-field="query:0:value"]').fill("project");
  await saveAndWait("#save");
  await page.locator('[data-settings-anchor="settings-basic"]').click();
  await page
    .locator('[data-settings-anchor="settings-global-parameters"]')
    .click();
  assert.equal(
    await page.locator('[data-global-field="headers:0:value"]').inputValue(),
    "shared-value",
  );
  await page.screenshot({ path: "/tmp/local-api-global-parameters.png" });
  await page.locator('.rail [data-page="apis"]').click();
  await page.getByRole("button", { name: "新建接口", exact: true }).click();
  await page
    .locator("#url")
    .fill(`http://127.0.0.1:${fixture.address().port}/global-parameters`);
  await page.locator("#send").click();
  await page
    .locator(".response-body")
    .getByText("shared-value", { exact: false })
    .waitFor();
  await page
    .locator(".response-body")
    .getByText("source=project", { exact: false })
    .waitFor();
  await page.locator('[data-mode="design"]').click();
  await page.locator("#inherit-global-parameters").uncheck();
  await saveAndWait("#save");
  await page.locator('[data-mode="debug"]').click();
  await page.locator("#send").click();
  await page
    .locator(".response-body")
    .getByText("absent", { exact: false })
    .waitFor();

  await page.locator('[data-mode="design"]').click();
  await page.locator("#inherit-global-parameters").check();
  await page.locator("#folder").fill("参数目录");
  await saveAndWait("#save");
  await page.locator('.rail [data-page="settings"]').click();
  await page
    .locator('[data-settings-anchor="settings-global-parameters"]')
    .click();
  await page.locator("#parameter-scope").selectOption("参数目录");
  await page.locator('[data-global-add="headers"]').click();
  await page
    .locator('[data-global-field="headers:0:key"]')
    .fill("x-global-fixture");
  await page
    .locator('[data-global-field="headers:0:value"]')
    .fill("folder-value");
  await saveAndWait("#save");
  await page.locator("#parameter-scope").selectOption("");
  assert.equal(
    await page.locator('[data-global-field="headers:0:value"]').inputValue(),
    "shared-value",
  );
  await page.locator("#parameter-scope").selectOption("参数目录");
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-folder-parameters.png" });
  await page.locator('.rail [data-page="apis"]').click();
  await page.locator('[data-mode="debug"]').click();
  await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
    ),
    page.locator("#send").click(),
  ]);
  await page.waitForFunction(() => !document.querySelector("#send")?.disabled);
  await page
    .locator(".response-body")
    .getByText("folder-value", { exact: false })
    .waitFor();
  await page.locator('[data-edit-folder="参数目录"]').click();
  await page.locator("#folder-name").fill("参数目录改名");
  await page.locator("#dialog-save").click();
  await saveAndWait("#save");
  await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
    ),
    page.locator("#send").click(),
  ]);
  await page.waitForFunction(() => !document.querySelector("#send")?.disabled);
  await page
    .locator(".response-body")
    .getByText("folder-value", { exact: false })
    .waitFor();
  await page.locator('[data-edit-folder="参数目录改名"]').click();
  await page.locator("#folder-remove").check();
  await page.locator("#dialog-save").click();
  await saveAndWait("#save");
  await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
    ),
    page.locator("#send").click(),
  ]);
  await page.waitForFunction(() => !document.querySelector("#send")?.disabled);
  await page
    .locator(".response-body")
    .getByText("shared-value", { exact: false })
    .waitFor();

  await page.locator('.rail [data-page="settings"]').click();
  await page
    .locator('[data-settings-anchor="settings-global-parameters"]')
    .click();
  await page.locator("#parameter-scope").selectOption("");
  await page.locator("#shared-auth-enabled").check();
  await page.locator("#shared-auth-type").selectOption("bearer");
  await page.locator('[data-shared-auth="token"]').fill("shared-auth-fixture");
  assert.equal(
    await page.locator('[data-shared-auth="token"]').getAttribute("type"),
    "password",
  );
  await saveAndWait("#save");
  await page.locator('[data-shared-auth="token"]').scrollIntoViewIfNeeded();
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-shared-auth.png" });
  await page.locator('.rail [data-page="apis"]').click();
  await page.locator("#send").click();
  await page
    .locator(".response-body")
    .getByText("Bearer shared-auth-fixture", { exact: false })
    .waitFor();
  await page.locator('[data-param="auth"]').click();
  await page.locator("#inherit-auth").uncheck();
  const noSharedAuth = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const noSharedResult = await (await noSharedAuth).json();
  assert.equal(JSON.parse(noSharedResult.body).authorization, "");
  await page.waitForFunction(() => !document.querySelector("#send")?.disabled);

  await page.locator('.rail [data-page="settings"]').click();
  await page
    .locator('[data-settings-anchor="settings-global-parameters"]')
    .click();
  await page.locator("#parameter-scope").selectOption("");
  await page
    .locator('[data-shared-script="beforeScript"]')
    .fill(
      `pm.sendRequest('${fixtureURL}/auth',(error,response)=>{if(error)throw error;apt.setRequestHeader('x-shared-script','callback-ready');});`,
    );
  await page
    .locator('[data-shared-script="afterScript"]')
    .fill(
      'apt.setVar("shared-script-post","done"); apt.test("apt-response-browser",()=>{apt.response.to.be.success;apt.response.to.have.header("Content-Type");apt.expect(apt.response.json.sharedScript).to.equal("callback-ready");apt.expect(csv2array("name,age")[0]).to.deep.equal(["name","age"]);});',
    );
  await page.locator("#shared-scripts-enabled").check();
  await saveAndWait("#save");
  await page.locator("#shared-scripts-card").scrollIntoViewIfNeeded();
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-shared-scripts.png" });
  await page.locator('.rail [data-page="apis"]').click();
  const sharedScriptReply = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const sharedScriptResult = await (await sharedScriptReply).json();
  assert.equal(
    sharedScriptResult.outcome,
    "passed",
    JSON.stringify(sharedScriptResult),
  );
  assert.equal(
    JSON.parse(sharedScriptResult.body).sharedScript,
    "callback-ready",
  );
  assert.equal(sharedScriptResult.extracted["shared-script-post"], "done");
  assert.equal(sharedScriptResult.subrequests[0].scope, "project");
  assert(
    sharedScriptResult.assertions.some(
      (t) => t.name === "apt-response-browser" && t.passed,
    ),
    JSON.stringify(sharedScriptResult.assertions),
  );
  await page.waitForFunction(() => !document.querySelector("#send")?.disabled);
  await page.locator('[data-param="before"]').click();
  await page.locator("#inherit-shared-scripts").uncheck();
  const noScriptReply = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  assert.equal(
    JSON.parse((await (await noScriptReply).json()).body).sharedScript,
    "absent",
  );
  await page.waitForFunction(() => !document.querySelector("#send")?.disabled);

  assert.deepEqual(errors, []);
  console.log("UI_SMOKE_PASS");
} catch (error) {
  await page.screenshot({ path: "/tmp/local-api-failure.png" }).catch(() => {});
  console.error(
    "UI_FAILURE_STATE",
    await page
      .locator("body")
      .innerText()
      .catch(() => "unavailable"),
  );
  throw error;
} finally {
  releaseMCP();
  stdioChild?.kill();
  await page.context().tracing.stop({ path: "/tmp/local-api-trace.zip" });
  await browser.close();
  for (const session of h2Sessions) session.destroy();
  for (const socket of h2Sockets) socket.destroy();
  await Promise.all([
    new Promise((resolve) => h2Proxy.close(resolve)),
    new Promise((resolve) => h2Fixture.close(resolve)),
  ]);
  for (const socket of redisSockets) socket.destroy();
  await new Promise((resolve) => redisFixture.close(resolve));
  await ntlmFixture.close();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  await new Promise((r) => app.server.close(r));
  await rm(root, { recursive: true, force: true });
}
