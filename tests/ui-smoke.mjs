import MarkdownIt from "markdown-it";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { startNtlmFixture } from "./fixtures/ntlm-server.mjs";
import { modernApipostFixture } from "./fixtures/apipost-modern.mjs";
import { parseRESP } from "../src/redis.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  snapshotPlan,
  exportOpenAPI,
  normalizeRequest,
  importDocument,
} from "../src/core.mjs";
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
let oauth1Starts = 0,
  oauth1Exchanges = 0;
let uploadedMultipart,
  stdioChild,
  releaseMCP = () => {},
  mcpGate = Promise.resolve();
const jwtFixtureSecret = "fictional-browser-jwt-secret-".repeat(3);
const asapPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const asapNonces = new Set();
let responseMutationLeaks = 0;
const fixture = http.createServer(async (request, response) => {
  if (request.url.split("?")[0] === "/final-body") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        body: Buffer.concat(chunks).toString(),
        signature: request.headers["x-final-signature"],
      }),
    );
    return;
  }

  if (request.url.startsWith("/sdk-url/")) {
    for await (const chunk of request) {
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ url: request.url }));
    return;
  }
  if (request.url.split("?")[0] === "/script-form-body") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        pairs: [...new URLSearchParams(Buffer.concat(chunks).toString())],
        contentType: request.headers["content-type"],
        url: request.url,
        helper: request.headers["x-helper"],
        liveHeader: request.headers["x-live-entry"],
        repeatedHeader: request.headers["x-wire-repeat"],
        removed: request.headers["x-remove"] ?? null,
        readerDisabled: request.headers["x-reader-disabled"] ?? null,
        cookie: request.headers.cookie ?? null,
        removedMember: request.headers["x-remove-member"] ?? null,
      }),
    );
    return;
  }

  if (request.url === "/script-response-wire") {
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"wire":true}');
    return;
  }
  if (request.url === "/response-mutation-leak") responseMutationLeaks++;

  if (request.url === "/asap-auth") {
    try {
      assert.match(request.headers.authorization || "", /^Bearer /);
      const [h, p, signature] = request.headers.authorization
        .slice(7)
        .split(".");
      const header = JSON.parse(Buffer.from(h, "base64url"));
      const claims = JSON.parse(Buffer.from(p, "base64url"));
      assert.equal(header.alg, "RS256");
      assert.equal(header.kid, "fixture-service/key-1");
      assert.equal(
        verify(
          "sha256",
          Buffer.from(h + "." + p),
          asapPair.publicKey,
          Buffer.from(signature, "base64url"),
        ),
        true,
      );
      assert.equal(claims.iss, "fixture-service");
      assert.equal(claims.aud, "fixture-resource");
      assert.equal(claims.sub, "browser-fixture");
      assert.equal(claims.exp - claims.iat, 60);
      assert(claims.iat <= Math.floor(Date.now() / 1000));
      assert(claims.exp > Math.floor(Date.now() / 1000));
      assert.match(claims.jti, /^[0-9a-f-]{36}$/);
      assert.equal(asapNonces.has(claims.jti), false);
      asapNonces.add(claims.jti);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          asap: true,
          issuer: claims.iss,
          ttl: 60,
          fresh: true,
        }),
      );
    } catch {
      response.statusCode = 401;
      response.end("invalid ASAP fixture");
    }
    return;
  }
  if (request.url.startsWith("/jwt-auth")) {
    const url = new URL(request.url, "http://fixture");
    const token =
      request.headers.authorization?.slice(7) ||
      url.searchParams.get("signed") ||
      "";
    const [header, payload, signature] = token.split(".");
    const expected = createHmac("sha256", jwtFixtureSecret)
      .update(header + "." + payload)
      .digest("base64url");
    if (signature !== expected) {
      response.statusCode = 401;
      response.end("invalid signature");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        valid: true,
        sub: JSON.parse(Buffer.from(payload, "base64url")).sub,
        destination: url.searchParams.has("signed") ? "query" : "header",
      }),
    );
    return;
  }
  if (request.url.startsWith("/?query=")) {
    const query = new URL(request.url, "http://fixture.test");
    assert.equal(request.method, "GET");
    assert.equal(query.searchParams.has("readonly"), false);
    assert.equal(query.searchParams.get("param_p0"), "clickhouse-ui");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        meta: [{ name: "value", type: "String" }],
        data: [{ value: "clickhouse-ui" }],
      }),
    );
  } else if (
    request.url === "/oauth1-request" ||
    request.url === "/oauth1-access"
  ) {
    response.setHeader("content-type", "application/x-www-form-urlencoded");
    if (request.url === "/oauth1-request") oauth1Starts++;
    else oauth1Exchanges++;
    if (
      request.url === "/oauth1-access" &&
      !request.headers.authorization?.includes('oauth_verifier="1234"')
    ) {
      response.writeHead(400);
      response.end("invalid verifier");
      return;
    }
    response.end(
      request.url === "/oauth1-request"
        ? "oauth_token=ui-temp&oauth_token_secret=ui-temp-secret&oauth_callback_confirmed=true"
        : "oauth_token=ui-access&oauth_token_secret=ui-access-secret",
    );
  } else if (request.url.startsWith("/global-parameters")) {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        token: request.headers["x-global-fixture"] || "absent",
        authorization: request.headers.authorization || "",
        sharedScript: request.headers["x-shared-script"] || "absent",
        databaseValue: request.headers["x-database-fixture"] || "",
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
      JSON.stringify({
        authorization: request.headers.authorization,
        ...(request.headers["x-aws-repeat"]
          ? { awsRepeat: request.headers["x-aws-repeat"] }
          : {}),
        ...(request.headers["x-imported-task"]
          ? { importTask: request.headers["x-imported-task"] }
          : {}),
      }),
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
const redisCommands = [];
let redisValue = "redis-ui-fixture";
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
    redisCommands.push(command);
    if (command[0] === "SET") {
      assert.deepEqual(command, [
        "SET",
        "ui-fixture",
        "redis-written-value",
        "XX",
        "KEEPTTL",
      ]);
      redisValue = command[2];
      socket.end("+OK\r\n");
      return;
    }
    assert.deepEqual(command, ["GET", "ui-fixture"]);
    const value = Buffer.from(redisValue);
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
const browserContext = await browser.newContext({
  viewport: { width: 1440, height: 950 },
  recordVideo: { dir: "/tmp/local-api-video" },
});
const page = await browserContext.newPage();
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
  assert.equal(await page.locator("#script-dialect").inputValue(), "legacy");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#script-dialect").selectOption("apipost8");
  assert.equal(await page.locator("#script-dialect").inputValue(), "legacy");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#script-dialect").selectOption("apipost8");
  assert.equal(await page.locator("#script-dialect").inputValue(), "apipost8");

  const visualizationLeaks = [];
  const observeVisualization = (request) => {
    if (request.url().includes("visualizer-leak"))
      visualizationLeaks.push(request.url());
  };
  page.on("request", observeVisualization);
  const visualizationTemplate =
    "<h2>{{title}}</h2><table><thead><tr><th>名称</th><th>结果</th></tr></thead><tbody>{{#each rows}}<tr><td>{{name}}</td><td>{{value}}</td></tr>{{/each}}</tbody></table>" +
    '<script>parent.__visualizerExecuted=true</script><img src="' +
    fixtureURL +
    '/visualizer-leak.png" onerror="parent.__visualizerExecuted=true"><iframe src="' +
    fixtureURL +
    '/visualizer-leak-frame"></iframe><meta http-equiv="refresh" content="0;url=' +
    fixtureURL +
    '/visualizer-leak-nav"><style>@import url("' +
    fixtureURL +
    '/visualizer-leak.css");</style>';
  await page.locator('[data-page="apis"]').click();
  await page.locator('[data-param="after"]').click();
  await page
    .locator("#script-code")
    .fill(
      'pm.environment.set("uiSaved","persisted"); pm.globals.set("uiGlobal",0); pm.test("payload", () => pm.expect(pm.response.code).to.equal(200)); apt.assert("response.raw.status === 200"); postman.setEnvironmentVariable("legacyFromUI",response.json.message); console.log("script-done");' +
        `pm.sendRequest(${JSON.stringify(fixtureURL + "/token")},(error,reply)=>{if(error)throw error;pm.environment.set('scriptHTTPFromUI',reply.json().access_token);pm.test('scriptHTTPStatus',()=>pm.expect(reply.code).to.equal(200));pm.test('scriptHTTPSchema',()=>pm.expect(reply).to.have.jsonSchema({type:'object',properties:{access_token:{type:'string'}},required:['access_token']}));});` +
        `apt.Visualizing(${JSON.stringify(visualizationTemplate)}, {title: "响应结果", rows: [{name:"消息",value:pm.response.json().message},{name:"转义",value:"<b>不是HTML</b>"}]});` +
        'pm.test("JSON5 helper",()=>pm.expect(JSON5.parse("{unquoted:1,}").unquoted).to.equal(1));' +
        'pm.test("JSON Schema response",()=>pm.response.to.have.jsonSchema({type:"object",properties:{message:{type:"string"}},required:["message"]}));pm.test("JSON Schema negative",()=>pm.expect({message:2}).not.to.have.jsonSchema({type:"object",properties:{message:{type:"string"}},required:["message"]}));' +
        'apt.variables.set("dialectPrivate","local");pm.test("Apipost8 JSON",()=>pm.expect(apt.response.json().message).to.equal(pm.response.json().message));' +
        'apt.setVar("fakerCompany", mockExp("{{$fakerjs.Company.name}}")); pm.test("Apipost Faker helper",()=>pm.expect(apt.getVar("fakerCompany")).to.be.a("string"));' +
        'pm.test("execution context",()=>{pm.expect(apt.environment.getName()).to.be.a("string").and.not.empty;pm.expect(pm.environment.id).to.be.a("string").and.not.empty;pm.expect(pm.variables.getName()).to.equal(apt.environment.getName());pm.expect(apt.info.eventName).to.equal("test");pm.expect(apt.info.requestId.length).to.be.above(0);if(apt.iterationData.has("loadFixture")){pm.expect(apt.info.iterationCount).to.equal(2);pm.expect(pm.iterationData.get("loadFixture")).to.equal(apt.info.iteration===0?"first":"second");}else{pm.expect(apt.info.iteration).to.equal(0);pm.expect(apt.info.iterationCount).to.equal(1);}});',
    );
  const scriptHelperReply = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const scriptHelperResult = await (await scriptHelperReply).json();
  assert.equal(
    scriptHelperResult.outcome,
    "passed",
    JSON.stringify(scriptHelperResult),
  );
  assert.equal(scriptHelperResult.extracted.dialectPrivate, undefined);
  assert.equal(typeof scriptHelperResult.extracted.fakerCompany, "string");
  assert(scriptHelperResult.extracted.fakerCompany.length > 0);
  await page.locator('[data-response="logs"]').click();
  await page
    .locator(".response-body")
    .getByText("script-done", { exact: false })
    .waitFor();
  await page.locator('[data-response="visualization"]').click();
  const visualization = page.frameLocator("#response-visualization");
  await visualization
    .locator("h2")
    .getByText("响应结果", { exact: true })
    .waitFor();
  assert.equal(await visualization.locator("tbody tr").count(), 2);
  assert.equal(
    await visualization
      .locator("tbody")
      .getByText("<b>不是HTML</b>", { exact: true })
      .count(),
    1,
  );
  assert.equal(
    await visualization.locator("script,img,iframe,style,body meta").count(),
    0,
  );
  assert.equal(
    await page.locator("#response-visualization").getAttribute("sandbox"),
    "",
  );
  assert.equal(
    await visualization.locator("body").evaluate(() => {
      try {
        void parent.document;
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await page.waitForFunction(() => {
    const frame = document.querySelector("#response-visualization");
    return frame && frame.getAttribute("srcdoc").includes("visualizer.css");
  });
  assert.equal(
    await visualization
      .locator("body")
      .evaluate((element) => getComputedStyle(element).fontSize),
    "14px",
  );
  assert.equal(
    await page.evaluate(() => Boolean(window.__visualizerExecuted)),
    false,
  );
  assert.deepEqual(visualizationLeaks, []);
  page.off("request", observeVisualization);
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-response-visualizer.png" });
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
  await page.locator("#load-data").fill("");
  await page.locator("#load-mode").selectOption("duration");
  await page.locator("#load-duration").fill("0");
  await page.locator("#load-run").click();
  await page
    .getByText("压测持续时长须为1至60秒整数", { exact: true })
    .waitFor();
  await page.locator("#load-duration").fill("60");
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
  assert.equal(await page.locator("#load-mode").inputValue(), "duration");
  assert.equal(await page.locator("#load-duration").inputValue(), "60");
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
  assert.equal(loadPayload.mode, "duration");
  assert.equal(loadPayload.stopReason, "count-limit");
  assert.equal(loadPayload.cancelled, false);
  await page.getByText("达到请求上限", { exact: true }).waitFor();
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
    .fill(
      `curl -X GET --data-urlencode 'q=中文 +值' --url-query 'filter=中文 +值' '${app.url}/api/session'`,
    );
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert((await page.locator("[data-request]").count()) === 3);
  const importedCurl = (
    await app.store.get(await page.locator("#project-select").inputValue())
  ).requests.at(-1);
  assert.equal(importedCurl.method, "GET");
  assert.equal(
    importedCurl.url,
    app.url + "/api/session?filter=%e4%b8%ad%e6%96%87+%2b%e5%80%bc",
  );
  assert.equal(importedCurl.body, "q=%E4%B8%AD%E6%96%87+%2B%E5%80%BC");
  assert(
    importedCurl.headers.some(
      (header) =>
        header.key.toLowerCase() === "content-type" &&
        header.value === "application/x-www-form-urlencoded",
    ),
  );
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
  assert.equal(await page.locator("#save").count(), 0);
  await page.locator("#mcp-reveal-config").click();
  await page.waitForFunction(() =>
    /Bearer [a-f0-9]{64}/.test(
      document.querySelector("#mcp-inline-code").textContent,
    ),
  );
  await page.locator('[data-mcp-preview-client="Codex"]').click();
  assert(
    (await page.locator("#mcp-inline-code").innerText()).includes(
      "[mcp_servers.localapi]",
    ),
  );
  await page.locator('[data-mcp-preview-client="Codex"]').press("ArrowRight");
  assert.equal(
    await page
      .locator('[data-mcp-preview-client="Claude Code"]')
      .getAttribute("aria-selected"),
    "true",
  );
  await page.locator('[data-mcp-preview-client="VS Code"]').click();
  assert(
    JSON.parse(await page.locator("#mcp-inline-code").innerText()).servers
      .localapi,
  );
  await page.locator("#mcp-reveal-config").click();
  assert(
    !(await page.locator("#mcp-inline-code").innerText()).match(
      /Bearer [a-f0-9]{64}/,
    ),
  );
  assert(await page.locator("#mcp-copy-config").isDisabled());
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-mcp-access-panel.png" });
  await page.locator("#mcp-config").click();
  await page.locator("#mcp-enabled").uncheck();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator("#mcp-config").click();
  await page.locator("#dialog").waitFor({ state: "visible" });
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
  await page
    .locator('[data-auth="requestTokenEndpoint"]')
    .fill(fixtureURL + "/oauth1-request");
  await page
    .locator('[data-auth="authorizationEndpoint"]')
    .fill(fixtureURL + "/authorize");
  await page
    .locator('[data-auth="tokenEndpoint"]')
    .fill(fixtureURL + "/oauth1-access");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#oauth1-get").click();
  assert.equal(await page.locator("#oauth1-verifier").count(), 0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#oauth1-get").evaluate((button) => {
    button.click();
    button.click();
  });
  await page.locator("#oauth1-verifier").waitFor();
  assert.equal(oauth1Starts, 1);
  assert.equal(
    new URL(
      await page.locator("#dialog a").getAttribute("href"),
    ).searchParams.get("oauth_token"),
    "ui-temp",
  );
  await page.locator("#oauth1-verifier").fill("1234");
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-oauth1-flow.png" });
  await page.locator("#dialog-save").evaluate((button) => {
    button.click();
    button.click();
  });
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.equal(
    await page.locator('[data-auth="accessToken"]').inputValue(),
    "ui-access",
  );
  assert.equal(
    await page.locator('[data-auth="tokenSecret"]').inputValue(),
    "ui-access-secret",
  );
  assert.equal(oauth1Exchanges, 1);
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
  // Isolate authentication from response-specific scripts on this reused tab.
  const awsSavedScripts = {};
  for (const phase of ["before", "after"]) {
    await page.locator(`[data-param="${phase}"]`).click();
    awsSavedScripts[phase] = await page.locator("#script-code").inputValue();
    await page.locator("#script-code").fill("");
  }
  await page.locator('[data-param="auth"]').click();
  await page.locator("#auth-type").selectOption("aws");
  for (const [key, value] of Object.entries({
    accessKey: "fixture-access",
    secretKey: "fixture-aws-secret",
    region: "us-east-1",
    service: "execute-api",
  }))
    await page.locator('[data-auth="' + key + '"]').fill(value);
  await page.locator('[data-param="headers"]').click();
  const awsHeaderStart = await page
    .locator('[data-pair^="headers:"][data-pair$=":key"]')
    .count();
  for (const [offset, value] of [" first  value ", " second "].entries()) {
    await page.locator('[data-add-pair="headers"]').click();
    await page
      .locator(`[data-pair="headers:${awsHeaderStart + offset}:key"]`)
      .fill("X-AWS-Repeat");
    await page
      .locator(`[data-pair="headers:${awsHeaderStart + offset}:value"]`)
      .fill(value);
  }
  await page.locator('[data-param="auth"]').click();
  const awsResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const awsResult = await (await awsResponse).json();
  assert.match(JSON.parse(awsResult.body).authorization, /^AWS4-HMAC-SHA256 /);
  assert(
    !JSON.parse(awsResult.body).authorization.includes("fixture-aws-secret"),
  );
  assert.equal(awsResult.status, 200);
  assert.equal(awsResult.outcome, "passed", JSON.stringify(awsResult));
  assert.equal(awsResult.error, undefined);
  assert.equal(JSON.parse(awsResult.body).awsRepeat, "first value,second");
  assert.equal(awsResult.request.headers["x-aws-repeat"], "first value,second");
  await page.locator("#send:not([disabled])").waitFor();
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-aws-repeat.png" });
  await page.locator('[data-param="headers"]').click();
  await page
    .locator(`[data-remove-pair="headers:${awsHeaderStart + 1}"]`)
    .click();
  await page.locator(`[data-remove-pair="headers:${awsHeaderStart}"]`).click();
  await page.locator('[data-param="auth"]').click();
  for (const phase of ["before", "after"]) {
    await page.locator(`[data-param="${phase}"]`).click();
    await page.locator("#script-code").fill(awsSavedScripts[phase]);
  }
  await page.locator('[data-param="auth"]').click();
  const beforeJWTRequest = await page
    .locator(".tab.selected [data-open-tab]")
    .getAttribute("data-open-tab");
  await page.getByRole("button", { name: "新建接口", exact: true }).click();
  await page.locator("#request-name").fill("JWT independent fixture");
  await page.locator("#url").fill(fixtureURL + "/jwt-auth");
  await page.locator('[data-param="auth"]').click();
  await page.locator("#auth-type").selectOption("jwt");
  await page.locator('[data-auth="secret"]').fill(jwtFixtureSecret);
  await page.locator('[data-auth="payload"]').fill('{"sub":"browser-fixture"}');
  await page.locator('[data-auth="header"]').fill('{"kid":"fixture-key"}');
  for (const destination of ["header", "queryParam"]) {
    await page.locator('[data-auth="addTokenTo"]').selectOption(destination);
    await page.locator('[data-auth="queryParamKey"]').fill("signed");
    const jwtResponse = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
    );
    await page.locator("#send").click();
    const jwtResult = await (await jwtResponse).json();
    assert.equal(jwtResult.status, 200);
    assert.equal(jwtResult.outcome, "passed", JSON.stringify(jwtResult));
    assert.deepEqual(JSON.parse(jwtResult.body), {
      valid: true,
      sub: "browser-fixture",
      destination: destination === "header" ? "header" : "query",
    });
  }
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.locator("#send:not([disabled])").waitFor();
  await page.screenshot({ path: "/tmp/local-api-jwt-auth.png" });
  await page.locator('[data-auth="payload"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/local-api-jwt-options.png" });
  await page.locator("#request-name").fill("ASAP independent fixture");
  await page.locator("#url").fill(fixtureURL + "/asap-auth");
  await page.locator("#auth-type").selectOption("asap");
  assert.equal(await page.locator('[data-auth="alg"]').inputValue(), "RS256");
  assert.equal(
    await page.locator('[data-auth="ttlSeconds"]').inputValue(),
    "60",
  );
  for (const [key, value] of Object.entries({
    iss: "fixture-service",
    aud: "fixture-resource",
    kid: "fixture-service/key-1",
    sub: "browser-fixture",
    privateKey: asapPair.privateKey.export({ type: "pkcs8", format: "pem" }),
  }))
    await page.locator('[data-auth="' + key + '"]').fill(value);
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
    );
    await page.locator("#send").click();
    const result = await (await reply).json();
    assert.equal(result.status, 200);
    assert.equal(result.outcome, "passed", JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.body), {
      asap: true,
      issuer: "fixture-service",
      ttl: 60,
      fresh: true,
    });
  }
  assert.equal(asapNonces.size, 2);
  // execute HTTP completion precedes the project/history refresh and final render.
  await page.locator("#send:not([disabled])").waitFor();
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.locator('[data-auth="iss"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/local-api-asap-auth.png" });
  await page.locator('[data-param="after"]').click();
  for (const expected of [61, 60]) {
    await page
      .locator("#script-code")
      .fill(
        'apt.test("JSON value",()=>apt.response.to.have.jsonBody("ttl",' +
          expected +
          '));pm.test("JSON format",()=>pm.response.to.have.jsonBody());apt.test("JSON missing",()=>apt.response.to.not.have.jsonBody("error"));',
      );
    const reply = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
    );
    await page.locator("#send").click();
    const result = await (await reply).json();
    assert.equal(result.status, 200);
    assert.equal(
      result.outcome,
      expected === 60 ? "passed" : "failed",
      JSON.stringify(result),
    );
    await page.locator("#send:not([disabled])").waitFor();
  }
  await page.locator('[data-response="assertions"]').click();
  await page
    .locator(".response-body")
    .getByText("JSON value", { exact: false })
    .waitFor();
  await page.screenshot({ path: "/tmp/local-api-jsonbody-assertions.png" });
  await page.locator('[data-response="body"]').click();

  await page.locator('[data-open-tab="' + beforeJWTRequest + '"]').click();
  await page.locator('[data-param="auth"]').click();
  await page.locator("#auth-type").selectOption("hawk");
  await page.locator('[data-auth="id"]').fill("hawk-fixture");
  await page.locator('[data-auth="key"]').fill("hawk-fixture-secret");
  await page.locator('[data-param="headers"]').click();
  const hawkHeaderStart = await page
    .locator('[data-pair^="headers:"][data-pair$=":key"]')
    .count();
  for (const [offset, value] of ["first", "second"].entries()) {
    await page.locator('[data-add-pair="headers"]').click();
    await page
      .locator(`[data-pair="headers:${hawkHeaderStart + offset}:key"]`)
      .fill("X-Hawk-Repeat");
    await page
      .locator(`[data-pair="headers:${hawkHeaderStart + offset}:value"]`)
      .fill(value);
  }
  await page.locator('[data-param="auth"]').click();
  const hawkResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const hawkResult = await (await hawkResponse).json();
  assert.match(JSON.parse(hawkResult.body).authorization, /^Hawk /);
  assert(
    !JSON.parse(hawkResult.body).authorization.includes("hawk-fixture-secret"),
  );
  assert.deepEqual(hawkResult.request.headers["x-hawk-repeat"], [
    "first",
    "second",
  ]);
  await page.locator('[data-param="headers"]').click();
  await page
    .locator(`[data-remove-pair="headers:${hawkHeaderStart + 1}"]`)
    .click();
  await page.locator(`[data-remove-pair="headers:${hawkHeaderStart}"]`).click();
  await page.locator('[data-param="auth"]').click();
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
  const beforeNTLMRequest = await page
    .locator(".tab.selected [data-open-tab]")
    .getAttribute("data-open-tab");
  await page.getByRole("button", { name: "新建接口", exact: true }).click();
  await page.locator("#request-name").fill("NTLM independent fixture");
  await page.locator('[data-param="auth"]').click();
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
  assert.equal(ntlmResult.outcome, "passed", JSON.stringify(ntlmResult));
  assert.equal(JSON.parse(ntlmResult.body).ntlm, true);
  assert.equal(ntlmFixture.stats.sockets.size, 1);
  await page.locator("#send:not([disabled])").waitFor();
  await page.locator("#toast").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".form-grid .notice").count(), 0);
  const ntlmUsernameBox = await page
    .locator('[data-auth="username"]')
    .boundingBox();
  assert(
    ntlmUsernameBox && ntlmUsernameBox.width >= 200,
    "NTLM inputs retain the full-width form column",
  );
  await page.locator('[data-auth="username"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/local-api-ntlm.png" });
  await page.locator('[data-open-tab="' + beforeNTLMRequest + '"]').click();
  await page.locator('[data-param="auth"]').click();
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
  await page.locator("#document-image").setInputFiles({
    name: "invalid.png",
    mimeType: "image/png",
    buffer: Buffer.from("not a PNG"),
  });
  await page.getByText("PNG文件头无效", { exact: true }).waitFor();
  assert.equal(await page.locator("#document-preview img").count(), 0);
  await page
    .locator("#document-content")
    .evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
  await page.locator("#document-image").setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
      "base64",
    ),
  });
  await page.waitForFunction(
    () => document.querySelector("#document-preview img")?.naturalWidth === 1,
  );
  await page.locator("#document-status").selectOption("ready");
  await page.locator('[data-doc-attribute="mail"]').fill("doc@example.test");
  await page.locator("#dialog-save").click();
  await page.locator("#app").getByText("已完成", { exact: true }).waitFor();
  await page.locator("#app .markdown-content table").waitFor();
  await page.locator("#toast").waitFor({ state: "hidden" });
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
  await page.locator("#edit-global-definitions").click();
  const tenantRow = page.locator('[data-variable-index="0"]');
  await tenantRow.locator('[data-variable-field="initial"]').fill("{invalid");
  await page.locator("#dialog-save").click();
  await page.getByText("第1行初始值不是有效JSON", { exact: false }).waitFor();
  assert(await page.locator("#dialog").isVisible());
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator("#edit-global-definitions").click();
  assert.equal(
    await tenantRow.locator('[data-variable-field="initial"]').inputValue(),
    '"ui-global"',
  );
  await tenantRow
    .locator('[data-variable-field="initial"]')
    .fill('"initial-global"');
  await tenantRow
    .locator('[data-variable-field="description"]')
    .fill("Tenant initial value");
  await page.locator("#toast").waitFor({ state: "hidden" });
  assert.equal(
    await tenantRow
      .locator('[data-variable-field="initial"]')
      .evaluate((element) => getComputedStyle(element).minHeight),
    "74px",
  );
  assert.equal(
    await tenantRow
      .locator('[data-variable-field="initial"]')
      .evaluate((element) => element.getBoundingClientRect().height),
    74,
  );
  await page.screenshot({ path: "/tmp/local-api-variable-definitions.png" });
  await page.locator("#dialog-save").click();
  await page.locator("[data-edit-variable-definitions]").first().click();
  await page.locator("#variable-add").click();
  const addedVariable = page.locator("[data-variable-index]").last();
  await addedVariable
    .locator('[data-variable-field="key"]')
    .fill("uiDualValue");
  await addedVariable
    .locator('[data-variable-field="initial"]')
    .fill('"first"');
  await addedVariable
    .locator('[data-variable-field="current"]')
    .fill('"second"');
  await addedVariable
    .locator('[data-variable-field="description"]')
    .fill("UI dual values");
  await page.locator("#dialog-save").click();
  await saveAndWait();
  const variableProjectId = await page.locator("#project-select").inputValue();
  const variableProject = await app.store.get(variableProjectId);
  assert.equal(variableProject.globalVariables.tenant, "ui-global");
  assert.deepEqual(variableProject.globalVariableDefinitions.tenant, {
    initialValue: "initial-global",
    description: "Tenant initial value",
  });
  assert.equal(variableProject.environments[0].variables.uiDualValue, "second");
  assert.equal(
    variableProject.environments[0].variableDefinitions.uiDualValue
      .initialValue,
    "first",
  );
  await page.locator("[data-edit-variable-definitions]").first().click();
  const persistedVariable = page.locator(
    '[data-variable-index]:has([data-variable-field="key"][value="uiDualValue"])',
  );
  await persistedVariable
    .locator('[data-variable-field="currentSet"]')
    .uncheck();
  assert(
    await persistedVariable
      .locator('[data-variable-field="current"]')
      .isDisabled(),
  );
  await persistedVariable.locator("[data-variable-reset]").click();
  assert.equal(
    await persistedVariable
      .locator('[data-variable-field="current"]')
      .inputValue(),
    '"first"',
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(
    (await app.store.get(variableProjectId)).environments[0].variables
      .uiDualValue,
    "second",
  );
  const paginated = await page.evaluate(async () => {
    const { mountVariableEditor } = await import("/variable-editor.js");
    const host = document.createElement("div");
    document.body.append(host);
    try {
      const editor = mountVariableEditor(
        host,
        Array.from({ length: 51 }, (_, index) => ({
          key: "page" + index,
          initialValue: index,
          currentValue: index,
          currentSet: true,
          description: "",
          initialExplicit: true,
        })),
      );
      host.querySelector(
        '[data-variable-index="0"] [data-variable-field="current"]',
      ).value = "100";
      host.querySelector('[data-variable-page="1"]').click();
      host.querySelector(
        '[data-variable-index="50"] [data-variable-field="current"]',
      ).value = "200";
      host.querySelector('[data-variable-page="-1"]').click();
      return editor.read();
    } finally {
      host.remove();
    }
  });
  assert.equal(paginated.values.page0, 100);
  assert.equal(paginated.values.page50, 200);
  assert.equal(paginated.definitions.page0.initialValue, 0);
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
  await page.locator("#edit-global-definitions").click();
  assert.equal(
    await page
      .locator('[data-variable-index="0"] [data-variable-field="initial"]')
      .inputValue(),
    '"initial-global"',
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();

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
  const exampleMockURL = await page.locator(".mock-url").inputValue();
  const exampleRequestId = new URL(exampleMockURL).pathname.split("/").at(-1);
  const exampleProjectId = await page.locator("#project-select").inputValue();
  const originalExamples = structuredClone(
    (await app.store.get(exampleProjectId)).requests.find(
      (r) => r.id === exampleRequestId,
    ).examples,
  );
  await page.locator("#add-example").click();
  await page.locator("#ex-name").fill("Exact empty mock");
  await page.locator("#ex-status").fill("200");
  await page.locator("#ex-body").fill("");
  await page.locator("#ex-headers").fill(
    JSON.stringify({
      "content-type": "text/plain",
      "x-example": "preserved",
    }),
  );
  await page.locator("#ex-delay").fill("1");
  const exampleSaveBounds = await page.locator("#dialog-save").boundingBox();
  assert(
    exampleSaveBounds.y >= 0 &&
      exampleSaveBounds.y + exampleSaveBounds.height <=
        page.viewportSize().height,
    "example save action remains reachable",
  );
  const exampleFieldsVisible = await page
    .locator("#dialog-content")
    .evaluate((content) => {
      const bounds = content.getBoundingClientRect();
      return [...content.querySelectorAll("input, textarea")].every((field) => {
        const box = field.getBoundingClientRect();
        return box.top >= bounds.top && box.bottom <= bounds.bottom;
      });
    });
  assert(
    exampleFieldsVisible,
    "example fields must not be obscured by the footer at the desktop viewport",
  );
  await page.screenshot({ path: "/tmp/local-api-response-example.png" });
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await saveAndWait();
  const exampleIndex = (await app.store.get(exampleProjectId)).requests
    .find((r) => r.id === exampleRequestId)
    .examples.findIndex((e) => e.name === "Exact empty mock");
  assert(exampleIndex >= 0);
  await page.reload();
  await page.locator('[data-request="' + exampleRequestId + '"]').click();
  await page.locator('[data-mode="mock"]').click();
  await page.locator('[data-edit-example="' + exampleIndex + '"]').click();
  assert.equal(await page.locator("#ex-body").inputValue(), "");
  assert.deepEqual(JSON.parse(await page.locator("#ex-headers").inputValue()), {
    "content-type": "text/plain",
    "x-example": "preserved",
  });
  await page.locator("#ex-headers").fill('{"Content-Length":"999"}');
  await page.locator("#dialog-save").click();
  await page.locator("#toast").getByText("传输", { exact: false }).waitFor();
  assert.equal(await page.locator("#dialog").isVisible(), true);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator('[data-edit-example="' + exampleIndex + '"]').click();
  assert.equal(
    JSON.parse(await page.locator("#ex-headers").inputValue())["x-example"],
    "preserved",
    "invalid/cancelled edits do not replace metadata",
  );
  await page.locator("#ex-name").fill("Exact empty mock edited");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-use-example="' + exampleIndex + '"]').click();
  // The URL bar exists in Mock mode too; wait for the asynchronous save and
  // target transition, not merely for an already-visible Send button.
  await page.waitForFunction((index) => {
    const input = document.querySelector("#url");
    return (
      input &&
      new URL(input.value, location.href).searchParams.get("example") ===
        String(index)
    );
  }, exampleIndex);
  assert.equal(
    new URL(await page.locator("#url").inputValue()).searchParams.get(
      "example",
    ),
    String(exampleIndex),
  );
  assert.equal(
    (await app.store.get(exampleProjectId)).requests.find(
      (item) => item.id === exampleRequestId,
    ).examples[exampleIndex].name,
    "Exact empty mock edited",
    "selecting Mock saves pending example changes first",
  );
  const selectedExampleResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const selectedExampleResult = await (await selectedExampleResponse).json();
  assert.equal(selectedExampleResult.status, 200);
  assert.equal(selectedExampleResult.body, "");
  await page.locator('[data-mode="mock"]').click();
  const exactMock = await page.request.get(
    exampleMockURL + "?example=" + exampleIndex,
  );
  assert.equal(exactMock.status(), 200);
  assert.equal(await exactMock.text(), "");
  assert.equal(exactMock.headers()["content-type"], "text/plain");
  assert.equal(exactMock.headers()["x-example"], "preserved");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator('[data-delete-example="' + exampleIndex + '"]').click();
  assert.equal(
    await page.locator('[data-edit-example="' + exampleIndex + '"]').count(),
    1,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('[data-delete-example="' + exampleIndex + '"]').click();
  await saveAndWait();
  assert.deepEqual(
    (await app.store.get(exampleProjectId)).requests.find(
      (r) => r.id === exampleRequestId,
    ).examples,
    originalExamples,
  );
  await page.locator("#toast").waitFor({ state: "hidden" });

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
  await page.locator("#import-parameter-dictionary").click();
  await page.locator("#dictionary-format").selectOption("mysql");
  await page
    .locator("#dictionary-source")
    .fill("CREATE TABLE t(id BIGINT DEFAULT 9007199254740993);");
  await page.locator("#dialog-save").click();
  await page
    .getByText("DDL默认数值超出JSON安全精度", { exact: false })
    .last()
    .waitFor();
  assert.equal(await page.locator("#dictionary-format").inputValue(), "mysql");
  await page
    .locator("#dictionary-source")
    .fill(
      "CREATE TABLE t(ddlChoice ENUM('a)b','x,y') DEFAULT 'a)b' COMMENT 'NOT NULL DEFAULT 7', ddlTime TIMESTAMP DEFAULT CURRENT_TIMESTAMP(6), ddlAmount DOUBLE DEFAULT 1e3);",
    );
  const ddlReply = page.waitForResponse(
    (r) => r.url().endsWith("/dictionary-preview") && r.status() === 200,
  );
  await page.locator("#dialog-save").click();
  const ddlPreview = await (await ddlReply).json();
  const ddlChoice = ddlPreview.find(
    (item) => item.entry.key === "ddlChoice",
  ).entry;
  assert.deepEqual(ddlChoice.enum, ["a)b", "x,y"]);
  assert.equal(ddlChoice.default, "a)b");
  assert.equal(ddlChoice.required, false);
  assert.equal(
    ddlPreview.find((item) => item.entry.key === "ddlAmount").entry.default,
    1000,
  );
  await page
    .locator("#dialog-title")
    .getByText("确认字典导入", { exact: true })
    .waitFor();
  await page
    .locator("#dialog")
    .getByText("默认表达式未求值: CURRENT_TIMESTAMP(6)", { exact: false })
    .waitFor();
  await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.status() === 200,
    ),
    page.locator("#dialog-save").click(),
  ]);
  await page.reload();
  await page.locator('[data-page="dictionary"]').click();
  await page.getByText("ddlChoice", { exact: true }).waitFor();
  await page
    .getByText("默认表达式未求值: CURRENT_TIMESTAMP(6)", { exact: false })
    .waitFor();
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-dictionary-ddl.png" });

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
  const idleSchemaLayout = await page
    .locator(".schema-layout")
    .evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      tree: element.querySelector(".schema-tree").getBoundingClientRect().width,
      fields: getComputedStyle(element.querySelector(".schema-fields")).display,
    }));
  assert(idleSchemaLayout.tree >= idleSchemaLayout.width - 1);
  assert.equal(idleSchemaLayout.fields, "none");
  await page.locator('[data-schema-add="0"]').click();
  const activeSchemaLayout = await page
    .locator(".schema-layout")
    .evaluate((element) => {
      const tree = element
          .querySelector(".schema-tree")
          .getBoundingClientRect(),
        fields = element
          .querySelector(".schema-fields")
          .getBoundingClientRect();
      return {
        treeWidth: tree.width,
        fieldsWidth: fields.width,
        gap: fields.left - tree.right,
      };
    });
  assert(
    activeSchemaLayout.treeWidth > 200 && activeSchemaLayout.fieldsWidth > 200,
  );
  assert(activeSchemaLayout.gap >= 0);
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
  const identifierSchema = structuredClone(visualSchema);
  identifierSchema.properties["metadata-remove"] = {
    type: "object",
    properties: { $id: { type: "string" } },
    example: { $id: "payload-id", $anchor: "payload-anchor" },
  };
  identifierSchema.properties["metadata-protected"] = {
    type: "string",
    $anchor: "real-anchor",
  };
  await page.locator("#schema").fill(JSON.stringify(identifierSchema));
  await page.locator("#visual-schema").click();
  await page
    .locator(".schema-tree tbody tr")
    .filter({ has: page.getByText("metadata-protected", { exact: true }) })
    .locator("[data-schema-remove]")
    .click();
  await page
    .locator(".schema-error")
    .getByText("包含结构标识或锚点，请用JSON编辑删除", { exact: true })
    .waitFor();
  const stickySchemaHeader = await page
    .locator(".schema-tree")
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return {
        scroll: element.scrollTop,
        top: element.getBoundingClientRect().top,
        header: element.querySelector("thead").getBoundingClientRect().top,
      };
    });
  assert(stickySchemaHeader.scroll > 0);
  assert(Math.abs(stickySchemaHeader.top - stickySchemaHeader.header) <= 2);
  await page.screenshot({ path: "/tmp/local-api-schema-identifier-guard.png" });
  await page
    .locator(".schema-tree tbody tr")
    .filter({ has: page.getByText("metadata-remove", { exact: true }) })
    .locator("[data-schema-remove]")
    .click();
  assert.equal(await page.locator(".schema-error").innerText(), "");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await saveAndWait("#save");
  const identifierSaved = (
    await app.store.get(await page.locator("#project-select").inputValue())
  ).requests.find((item) => item.id === schemaRequestId).schema;
  assert.equal(
    Object.hasOwn(identifierSaved.properties, "metadata-remove"),
    false,
  );
  assert.equal(
    identifierSaved.properties["metadata-protected"].$anchor,
    "real-anchor",
  );
  delete identifierSaved.properties["metadata-protected"];
  assert.deepEqual(identifierSaved, visualSchema);
  await page.locator("#schema").fill(JSON.stringify(visualSchema));
  await saveAndWait("#save");
  const compositionSchema = {
    type: "integer",
    minimum: 0,
    allOf: [{ maximum: 5 }],
    example: 3,
    "x-data": { $ref: "#/allOf/0" },
  };
  await page.locator("#schema").fill(JSON.stringify(compositionSchema));
  const appendNumberBranch = async () => {
    await page.locator('[data-schema-branch-add="0"]').click();
    await page.locator("[data-schema-combination]").selectOption("allOf");
    await page.locator("[data-schema-branch-type]").selectOption("number");
    await page.locator("[data-schema-apply]").click();
  };
  const compositionRow = (index) =>
    page
      .locator(".schema-tree tbody tr")
      .filter({ has: page.getByText("allOf 分支 " + index, { exact: true }) });
  await page.locator("#visual-schema").click();
  await appendNumberBranch();
  await compositionRow(2).waitFor();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  assert.deepEqual(
    JSON.parse(await page.locator("#schema").inputValue()),
    compositionSchema,
  );
  await page.locator("#visual-schema").click();
  await appendNumberBranch();
  await compositionRow(1).locator("[data-schema-edit]").click();
  await page.locator(".schema-constraints summary").click();
  await page.locator('[data-schema-constraint="maximum"]').fill("10");
  await page.locator("[data-schema-apply]").click();
  await compositionRow(2).locator("[data-schema-branch-remove]").click();
  await compositionRow(1).locator("[data-schema-branch-remove]").click();
  await page
    .locator(".schema-error")
    .getByText("组合至少保留一个分支；移除整个组合请用JSON编辑", {
      exact: true,
    })
    .waitFor();
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await saveAndWait("#save");
  const compositionSaved = (
    await app.store.get(await page.locator("#project-select").inputValue())
  ).requests.find((item) => item.id === schemaRequestId).schema;
  assert.equal(compositionSaved.type, "integer");
  assert.equal(compositionSaved.minimum, 0);
  assert.equal(compositionSaved.allOf.length, 1);
  assert.equal(compositionSaved.allOf[0].maximum, 10);
  assert.deepEqual(compositionSaved["x-data"], compositionSchema["x-data"]);
  const guardedComposition = {
    ...compositionSaved,
    allOf: [...compositionSaved.allOf, { type: "number" }],
    $defs: { Keep: { $ref: "#/allOf/1" } },
  };
  await page.locator("#schema").fill(JSON.stringify(guardedComposition));
  await page.locator("#visual-schema").click();
  await compositionRow(1).locator("[data-schema-branch-remove]").click();
  await page
    .locator(".schema-error")
    .getByText("此字段被本地引用使用，请先在JSON中更新引用", { exact: true })
    .waitFor();
  await page.screenshot({ path: "/tmp/local-api-schema-compositions.png" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator("#schema").fill(JSON.stringify(visualSchema));
  await saveAndWait("#save");
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
  const responseChrome = await page.locator("#dialog").evaluate((dialog) => {
    const bounds = dialog.getBoundingClientRect();
    const header = dialog
      .querySelector(":scope > form > header")
      .getBoundingClientRect();
    const footer = dialog
      .querySelector(":scope > form > footer")
      .getBoundingClientRect();
    const close = dialog.querySelector('button[aria-label="关闭"]');
    const button = close.getBoundingClientRect();
    return {
      headerInside: header.top >= bounds.top && header.bottom <= bounds.bottom,
      footerInside: footer.top >= bounds.top && footer.bottom <= bounds.bottom,
      closeUnobscured: close.contains(
        document.elementFromPoint(
          button.x + button.width / 2,
          button.y + button.height / 2,
        ),
      ),
      scrollTop: dialog.scrollTop,
    };
  });
  assert.deepEqual(
    responseChrome,
    {
      headerInside: true,
      footerInside: true,
      closeUnobscured: true,
      scrollTop: 0,
    },
    "schema field focus must not scroll the dialog title or close control away",
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
  // The edited request contains $defs: retain it in project storage, but do not
  // label that dialect as OpenAPI 3.0. Verify response-only export separately.
  assert.throws(
    () =>
      exportOpenAPI({
        name: "unsupported schema dialect",
        requests: [responseRequest],
      }),
    /OpenAPI 3\.0.*\$defs/,
  );
  const exportedResponse = exportOpenAPI({
    name: "visual response",
    requests: [{ ...responseRequest, schema: {} }],
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
  tupleSchema.properties.combined = {
    allOf: [
      {
        type: "object",
        properties: { count: { type: "integer", minimum: 2 } },
        required: ["count"],
      },
      {
        type: "object",
        properties: { label: { type: "string", minLength: 2 } },
        required: ["label"],
      },
    ],
  };
  tupleSchema.properties.alternative = {
    minimum: 7,
    anyOf: [false, { type: "integer" }],
  };
  tupleSchema.properties.exclusive = {
    oneOf: [{ type: "string", minLength: 2 }, { type: "boolean" }],
  };
  tupleSchema.properties.tagged = {
    oneOf: [
      {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { const: "cat" },
          lives: { type: "integer", minimum: 9 },
        },
      },
      {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { enum: ["dog", "wolf"] },
          barks: { type: "boolean" },
        },
      },
    ],
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
  assert.equal(generatedBody.alternative, 7);
  assert.equal(generatedBody.exclusive, "xx");
  assert.deepEqual(generatedBody.tagged, { kind: "cat", lives: 9 });
  assert.deepEqual(generatedBody.combined, { count: 2, label: "xx" });
  assert.equal(generatedBody.flag, false);
  await page.locator("#expand-body").click();
  await page.screenshot({ path: "/tmp/local-api-schema-allof.png" });
  await page.keyboard.press("Escape");
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
  modern.apis[1].method = "POST";
  modern.apis[1].request.pre_tasks = [
    {
      type: "customScript",
      id: "browser-pre",
      name: "Imported pre",
      enabled: 1,
      data: 'apt.setRequestHeader("x-imported-task", "browser-kept");',
    },
  ];
  modern.apis[1].request.post_tasks = [
    {
      type: "customScript",
      id: "browser-post",
      name: "Imported post",
      enabled: 1,
      data: 'pm.test("imported response",()=>pm.expect(apt.response.json().importTask).to.equal("browser-kept"));',
    },
  ];
  modern.global.attributes = [
    {
      attribute_id: "browser-owner",
      project_id: modern.project_id,
      field_name: "Imported owner",
      field_type: 1,
      enable: 1,
      tooltip: "仅用于导入验证",
      sort: 1,
      extra: [],
      open_api_field: "",
    },
    {
      attribute_id: "browser-hidden",
      project_id: modern.project_id,
      field_name: "Hidden metric",
      field_type: 2,
      enable: -1,
      tooltip: "",
      sort: 2,
      extra: [],
      open_api_field: "",
    },
  ];
  modern.apis[1].attribute_info = {
    "browser-owner": "fixture-owner",
    "browser-hidden": 0,
  };
  modern.global.describe_library = [
    {
      id: "browser-description",
      project_id: modern.project_id,
      key: "X-Test",
      description: "导入请求头说明",
    },
  ];
  modern.global.codes = [
    {
      code_id: "browser-code",
      project_id: modern.project_id,
      code_number: "0007",
      code_msg: "导入业务错误说明",
    },
  ];
  modern.global.global_param.pre_tasks = [
    {
      type: "customScript",
      id: "browser-global",
      name: "Imported global source",
      enabled: 1,
      data: 'const inheritedPrefix = "browser";',
    },
  ];
  modern.apis[0].request.pre_tasks = [
    {
      type: "customScript",
      id: "browser-folder",
      name: "Imported folder source",
      enabled: 1,
      data: 'const inheritedSuffix = "kept";',
    },
  ];
  modern.apis[1].request.pre_tasks[0].data =
    'const importedStage = inheritedPrefix + "-" + inheritedSuffix; // first block';
  modern.apis[1].request.pre_tasks.push({
    type: "customScript",
    id: "browser-pre-second",
    name: "Imported pre second",
    enabled: 1,
    data: 'apt.setRequestHeader("x-imported-task", importedStage);',
  });
  modern.apis[1].request.post_tasks.unshift({
    type: "customScript",
    id: "browser-post-first",
    name: "Imported post first",
    enabled: 1,
    data: "const importedPayload = apt.response.json();",
  });
  modern.apis[1].request.post_tasks[1].data =
    'pm.test("imported response",()=>pm.expect(importedPayload.importTask).to.equal("browser-kept"));';
  modern.apis[1].request.pre_tasks.splice(1, 0, {
    type: "customScript",
    id: "browser-disabled",
    name: "Disabled browser source",
    enabled: -1,
    data: "throw Error('disabled browser source must not execute')",
  });
  modern.apis[1].request.body.mode = "plain";
  modern.apis[1].request.body.raw = "browser plain + & = text";
  modern.apis[1].mock_ip_white_list_enable = -1;
  modern.apis[1].request.header.parameter.push(
    { key: "X-Imported-Repeat", value: "first", is_checked: 1 },
    { key: "x-imported-repeat", value: "second", is_checked: 1 },
    { key: "X-Imported-Repeat", value: "hidden", is_checked: -1 },
  );
  modern.apis[1].response.example.push({
    raw: "",
    headers: [{ key: "X-Imported-Example", value: "kept", is_checked: 1 }],
    expect: {
      code: "204",
      content_type: "text",
      name: "Imported empty body",
      sleep: 80,
    },
  });
  modern.apis[1].request.query.parameter = [];
  modern.models = [
    {
      model_id: "browser-model-folder",
      model_type: "folder",
      name: "API Models",
      parent_id: "0",
    },
    {
      model_id: "browser-empty-folder",
      model_type: "folder",
      name: "Empty Model Group",
      parent_id: "browser-model-folder",
    },
    {
      model_id: "browser-model",
      model_type: "model",
      parent_id: "browser-model-folder",
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
  const importNotice = page.getByRole("region", { name: "导入兼容性提示" });
  const noticeLayout = await importNotice.evaluate((element) => ({
    height: element.clientHeight,
    content: element.scrollHeight,
    viewport: innerHeight,
    rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
    overflow: getComputedStyle(element).overflowY,
  }));
  assert.ok(noticeLayout.height > 0, JSON.stringify(noticeLayout));
  assert.ok(
    noticeLayout.height <=
      Math.min(18 * noticeLayout.rootFont, 0.35 * noticeLayout.viewport) + 1,
    JSON.stringify(noticeLayout),
  );
  assert.ok(
    noticeLayout.content > noticeLayout.height,
    JSON.stringify(noticeLayout),
  );
  assert.equal(noticeLayout.overflow, "auto");
  await importNotice.focus();
  await page.keyboard.press("PageDown");
  await page.waitForFunction(
    () => document.querySelector(".import-notes").scrollTop > 0,
  );
  await importNotice.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.locator(".imported-script-tasks > summary").click();
  await page
    .locator(".import-notes")
    .getByText("导入时快照", { exact: false })
    .waitFor();
  await page
    .locator(".imported-script-tasks summary")
    .filter({ hasText: "Imported global source" })
    .waitFor();
  await page
    .locator(".imported-script-tasks summary")
    .filter({ hasText: "Imported folder source" })
    .waitFor();
  await page
    .locator(".imported-script-tasks summary")
    .filter({ hasText: "Disabled browser source" })
    .click();
  await page
    .locator(".imported-script-tasks pre")
    .filter({
      hasText: "throw Error('disabled browser source must not execute')",
    })
    .waitFor();
  assert.equal(
    await page
      .locator(".imported-script-tasks textarea, .imported-script-tasks button")
      .count(),
    0,
  );
  const taskSourceProject = await app.store.get(
    await page.locator("#project-select").inputValue(),
  );
  const importedCode = taskSourceProject.settings.statusCodes.find(
    (item) => item.code === "0007",
  );
  assert.equal(importedCode.label, "导入业务错误说明");
  assert.notEqual(importedCode.httpHint, true);
  const taskSourceRequest = taskSourceProject.requests.find((request) =>
    request.importedScriptTasks?.before.some(
      (task) => task.id === "browser-disabled",
    ),
  );
  assert.equal(
    taskSourceRequest.importedScriptTasks.before.find(
      (task) => task.id === "browser-disabled",
    ).enabled,
    -1,
  );
  assert.equal(
    taskSourceRequest.importedScriptTasks.before.find(
      (task) => task.id === "browser-disabled",
    ).data,
    "throw Error('disabled browser source must not execute')",
  );
  await page.screenshot({
    path: "/tmp/local-api-imported-disabled-script.png",
  });
  const ownerField = page.getByLabel("Imported owner", { exact: true });
  assert.equal(await ownerField.inputValue(), "fixture-owner");
  assert.equal(
    await ownerField.getAttribute("aria-description"),
    "仅用于导入验证",
  );
  assert.equal(
    await page.getByLabel("Hidden metric", { exact: true }).count(),
    0,
  );
  await ownerField.fill("edited-owner");
  await saveAndWait();
  const attributeProject = await app.store.get(
    await page.locator("#project-select").inputValue(),
  );
  const hiddenDefinition = attributeProject.settings.attributes.find(
    (field) => field.label === "Hidden metric",
  );
  const ownerDefinition = attributeProject.settings.attributes.find(
    (field) => field.label === "Imported owner",
  );
  const attributeRequest = attributeProject.requests.find(
    (request) => request.id === taskSourceRequest.id,
  );
  assert.equal(attributeRequest.attributes[hiddenDefinition.key], 0);
  assert.equal(
    attributeRequest.attributes[ownerDefinition.key],
    "edited-owner",
  );
  await page
    .getByLabel("Imported owner", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/local-api-imported-attributes.png" });
  await page.locator("#env").selectOption({ label: "Imported" });
  await page.locator('[data-mode="debug"]').click();
  await page.locator('[data-param="headers"]').click();
  await page.locator('[data-define-pair="headers:0"]').click();
  const originalParameterDescription = await page
    .locator("#parameter-description")
    .inputValue();
  await page.locator("#description-choice").selectOption("0");
  await page.locator("#apply-parameter-description").click();
  assert.equal(
    await page.locator("#parameter-description").inputValue(),
    "导入请求头说明",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator('[data-define-pair="headers:0"]').click();
  assert.equal(
    await page.locator("#parameter-description").inputValue(),
    originalParameterDescription,
  );
  await page.locator("#description-choice").selectOption("0");
  await page.locator("#apply-parameter-description").click();
  await page.screenshot({
    path: "/tmp/local-api-parameter-description-choice.png",
  });
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await saveAndWait();
  const descriptionProject = await app.store.get(
    await page.locator("#project-select").inputValue(),
  );
  const describedHeader = descriptionProject.requests.find(
    (request) => request.id === taskSourceRequest.id,
  ).headers[0];
  assert.equal(describedHeader.description, "导入请求头说明");
  for (const field of ["key", "value", "required", "schema"])
    assert.deepEqual(
      describedHeader[field],
      taskSourceRequest.headers[0][field],
    );

  const modernResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const modernResult = await (await modernResponse).json();
  assert.equal(modernResult.status, 200, JSON.stringify(modernResult));
  assert.equal(modernResult.outcome, "passed", JSON.stringify(modernResult));
  assert.equal(modernResult.request.headers["x-test"], "current");
  assert.equal(modernResult.request.headers["x-imported-task"], "browser-kept");
  assert(
    modernResult.assertions.some(
      (a) => a.name === "imported response" && a.passed,
    ),
    JSON.stringify(modernResult.assertions),
  );
  assert.equal(modernResult.request.body, "browser plain + & = text");
  assert.equal(modernResult.request.headers["content-type"], "text/plain");
  assert.deepEqual(modernResult.request.headers["x-imported-repeat"], [
    "first",
    "second",
  ]);
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-apipost-modern.png" });
  await page.locator('[data-mode="mock"]').click();
  assert.equal(await page.locator("[data-edit-example]").count(), 2);
  await page.locator('[data-edit-example="1"]').click();
  assert.equal(
    await page.locator("#ex-name").inputValue(),
    "Imported empty body",
  );
  assert.equal(await page.locator("#ex-status").inputValue(), "204");
  assert.equal(await page.locator("#ex-body").inputValue(), "");
  assert.equal(await page.locator("#ex-delay").inputValue(), "80");
  assert.equal(
    JSON.parse(await page.locator("#ex-headers").inputValue())[
      "x-imported-example"
    ],
    "kept",
  );
  await page.screenshot({ path: "/tmp/local-api-imported-example-delay.png" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator('[data-page="docs"]').click();
  await page
    .locator(".error-code-document")
    .getByText("0007", { exact: true })
    .waitFor();
  await page
    .locator(".error-code-document")
    .getByText("导入业务错误说明", { exact: true })
    .waitFor();
  await page.screenshot({ path: "/tmp/local-api-imported-error-codes.png" });
  await page.locator('.rail [data-page="settings"]').click();
  await page
    .locator('[data-settings-anchor="resource-parameterDescriptions"]')
    .click();
  await page
    .locator(".parameter-descriptions")
    .getByText("X-Test", { exact: true })
    .waitFor();
  await page.locator("#new-parameter-description").click();
  await page.locator("#description-library-key").fill("local_note");
  await page.locator("#description-library-text").fill("本地维护");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-edit-parameter-description="1"]').click();
  await page.locator("#description-library-text").fill("本地维护已编辑");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page
    .locator(".parameter-descriptions")
    .getByText("本地维护已编辑", { exact: true })
    .waitFor();
  await page.screenshot({
    path: "/tmp/local-api-parameter-description-library.png",
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('[data-delete-parameter-description="1"]').click();
  await page
    .locator('[data-edit-parameter-description="1"]')
    .waitFor({ state: "hidden" });

  await page.locator('[data-page="dictionary"]').click();
  await page
    .getByText("Fictional modern export / BrowserModel", { exact: true })
    .waitFor();
  await page
    .locator(".model-folder > summary")
    .getByText("API Models", { exact: true })
    .waitFor();
  await page
    .locator(".model-folder > summary")
    .getByText("Empty Model Group", { exact: true })
    .waitFor();
  await page.getByText("空模型目录", { exact: true }).waitFor();
  await page
    .locator(".model-folder > summary")
    .getByText("API Models", { exact: true })
    .click();
  assert.equal(
    await page
      .getByText("Fictional modern export / BrowserModel", { exact: true })
      .isVisible(),
    false,
  );
  await page
    .locator(".model-folder > summary")
    .getByText("API Models", { exact: true })
    .click();
  await page.reload();
  await page.locator('[data-page="dictionary"]').click();
  await page
    .getByText("Fictional modern export / BrowserModel", { exact: true })
    .waitFor();
  await page.getByText("Empty Model Group", { exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/local-api-apipost-model.png" });
  const importedModelCard = page.locator(".card").filter({
    has: page.getByText("Fictional modern export / BrowserModel", {
      exact: true,
    }),
  });
  await importedModelCard.locator("[data-edit-dictionary]").click();
  await page.locator("#dialog").waitFor({ state: "visible" });
  const importedModelFolder = await page.locator("#dict-folder").inputValue();
  assert(importedModelFolder);
  await page.locator("#dict-name").fill("");
  await page.locator("#dialog-save").click();
  await page
    .getByText("模型名称须为1至500个字符", { exact: false })
    .last()
    .waitFor();
  assert(await page.locator("#dialog").isVisible());
  await page
    .locator("#dict-name")
    .fill("Fictional modern export / BrowserModel");
  await page
    .locator("#modal-json")
    .fill(JSON.stringify({ type: "object", properties: { id: { const: 8 } } }));
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  const modelSave = page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" &&
      r.status() === 200 &&
      r.url().includes("/api/projects/"),
  );
  await page.locator("#save-project").click();
  const savedModelProject = await (await modelSave).json();
  const savedModel = savedModelProject.dictionary.find(
    (m) => m.name === "Fictional modern export / BrowserModel",
  );
  assert(savedModel.id);
  assert.equal(savedModel.folderId, importedModelFolder);
  assert.equal(
    savedModelProject.openapiComponents.schemas[savedModel.id].properties.id
      .const,
    8,
  );
  await page.reload();
  await page.locator('[data-page="dictionary"]').click();
  await page
    .getByText("Fictional modern export / BrowserModel", { exact: true })
    .waitFor();
  await page
    .locator(".model-folder")
    .first()
    .screenshot({ path: "/tmp/local-api-model-folder-tree.png" });

  await page.locator("#add-model-folder").click();
  await page.locator("#model-folder-name").fill("");
  await page.locator("#dialog-save").click();
  await page
    .getByText("模型目录定义无效或ID重复", { exact: false })
    .last()
    .waitFor();
  assert(await page.locator("#dialog").isVisible());
  await page.locator("#model-folder-name").fill("UI Model Group");
  await page.locator("#model-folder-parent").selectOption(importedModelFolder);
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  const groupSummary = (name) =>
    page
      .locator("summary")
      .filter({ has: page.getByText(name, { exact: true }) });
  await groupSummary("UI Model Group")
    .locator("[data-edit-model-folder]")
    .click();
  await page.locator("#model-folder-name").fill("Discarded name");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.getByText("UI Model Group", { exact: true }).waitFor();
  await page
    .locator(".card")
    .filter({
      has: page.getByText("Fictional modern export / BrowserModel", {
        exact: true,
      }),
    })
    .locator("[data-edit-dictionary]")
    .click();
  await page
    .locator("#dict-folder")
    .selectOption({ label: "API Models / UI Model Group" });
  const movedModelFolder = await page.locator("#dict-folder").inputValue();
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert(
    await groupSummary("UI Model Group")
      .locator("[data-delete-model-folder]")
      .isDisabled(),
  );
  await groupSummary("UI Model Group")
    .locator("[data-edit-model-folder]")
    .click();
  await page.locator("#model-folder-name").fill("Edited Model Group");
  await page.locator("#model-folder-parent").selectOption("");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  page.once("dialog", (dialog) => dialog.dismiss());
  await groupSummary("Empty Model Group")
    .locator("[data-delete-model-folder]")
    .click();
  await page.getByText("Empty Model Group", { exact: true }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await groupSummary("Empty Model Group")
    .locator("[data-delete-model-folder]")
    .click();
  assert.equal(
    await page.getByText("Empty Model Group", { exact: true }).count(),
    0,
  );
  const foldersSave = page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" &&
      r.status() === 200 &&
      r.url().includes("/api/projects/"),
  );
  await page.locator("#save-project").click();
  const savedFoldersProject = await (await foldersSave).json();
  assert.equal(
    savedFoldersProject.dictionary.find((m) => m.id === savedModel.id).folderId,
    movedModelFolder,
  );
  assert.equal(
    savedFoldersProject.modelFolders.find((f) => f.id === movedModelFolder)
      .parentId,
    "",
  );
  await page.reload();
  await page.locator('[data-page="dictionary"]').click();
  await page.getByText("Edited Model Group", { exact: true }).waitFor();
  await page
    .locator(".model-folder")
    .filter({
      has: page.getByText("Fictional modern export / BrowserModel", {
        exact: true,
      }),
    })
    .screenshot({ path: "/tmp/local-api-model-folder-edit.png" });

  const inferredExample = { id: 7, tags: ["a", "b"], active: true };
  await page.locator("#add-dictionary").click();
  await page.locator("#dict-name").fill("JSON Inferred Model");
  await page
    .getByText("从 JSON / XML / MySQL DDL 生成 Schema", { exact: true })
    .click();
  const originalDraft = await page.locator("#modal-json").inputValue();
  await page.locator("#model-json-sample").fill("{");
  await page.locator("#infer-model-schema").click();
  await page
    .locator("#model-infer-error")
    .getByText("JSON样例格式无效", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#modal-json").inputValue(), originalDraft);
  await page
    .locator("#model-json-sample")
    .fill(JSON.stringify(inferredExample));
  await page.locator("#infer-model-schema").click();
  assert.deepEqual(
    JSON.parse(await page.locator("#modal-json").inputValue()).example,
    inferredExample,
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.equal(
    await page.getByText("JSON Inferred Model", { exact: true }).count(),
    0,
  );
  await page.locator("#add-dictionary").click();
  await page
    .locator("#dict-name")
    .fill("Fictional modern export / BrowserModel");
  await page
    .getByText("从 JSON / XML / MySQL DDL 生成 Schema", { exact: true })
    .click();
  await page
    .locator("#model-json-sample")
    .fill(JSON.stringify(inferredExample));
  await page.locator("#infer-model-schema").click();
  await page.locator("#dialog-save").click();
  await page
    .getByText("模型名称重复，请使用不同名称", { exact: false })
    .last()
    .waitFor();
  assert(await page.locator("#dialog").isVisible());
  await page.locator("#dict-name").fill("JSON Inferred Model");
  await page.locator("#dict-folder").selectOption(movedModelFolder);
  await page.locator("#modal-json").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/local-api-model-json-preview.png" });
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  const inferredSave = page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" &&
      r.status() === 200 &&
      r.url().includes("/api/projects/"),
  );
  await page.locator("#save-project").click();
  const inferredProject = await (await inferredSave).json();
  const inferredModel = inferredProject.dictionary.find(
    (m) => m.name === "JSON Inferred Model",
  );
  assert.deepEqual(inferredModel.schema.example, inferredExample);
  assert.equal(inferredModel.folderId, movedModelFolder);
  await page.reload();
  await page.locator('[data-page="dictionary"]').click();
  const inferredCard = page
    .locator(".card")
    .filter({ has: page.getByText("JSON Inferred Model", { exact: true }) });
  await inferredCard.locator("[data-use-dictionary]").click();
  await page.locator('[data-mode="debug"]').click();
  await page.locator('[data-param="body"]').click();
  await page.locator("#generate-body").click();
  await page.waitForFunction(() => {
    try {
      return JSON.parse(document.querySelector("#body-code").value).id === 7;
    } catch {
      return false;
    }
  });
  assert.deepEqual(
    JSON.parse(await page.locator("#body-code").inputValue()),
    inferredExample,
  );

  await saveAndWait("#save-project");

  await page.locator('[data-page="dictionary"]').click();
  await page.locator("#add-dictionary").click();
  await page.locator("#dict-name").fill("DDL Inferred Model");
  await page
    .getByText("从 JSON / XML / MySQL DDL 生成 Schema", { exact: true })
    .click();
  await page.locator("#model-source-format").selectOption("mysql");
  const ddlDraft = await page.locator("#modal-json").inputValue();
  await page
    .locator("#model-json-sample")
    .fill("CREATE TABLE t (id INT); DROP TABLE t");
  await page.locator("#infer-model-schema").click();
  await page
    .locator("#model-infer-error")
    .getByText("仅支持单条CREATE TABLE", { exact: false })
    .waitFor();
  assert.equal(await page.locator("#modal-json").inputValue(), ddlDraft);
  await page
    .locator("#model-json-sample")
    .fill(
      "CREATE TABLE t (id INT NOT NULL DEFAULT 7 COMMENT 'identifier', status ENUM('ready','a)b') DEFAULT 'ready', created DATETIME DEFAULT CURRENT_TIMESTAMP)",
    );
  await page.locator("#infer-model-schema").click();
  const ddlSchema = JSON.parse(await page.locator("#modal-json").inputValue());
  assert.equal(ddlSchema.properties.id.default, 7);
  assert.equal(ddlSchema.required, undefined);
  assert.deepEqual(ddlSchema.properties.status.enum, ["ready", "a)b"]);
  assert.match(ddlSchema.properties.created.description, /默认表达式未求值/);
  await page.locator("#modal-json").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/local-api-model-ddl-preview.png" });
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await saveAndWait("#save-project");
  await page.reload();
  await page.locator('[data-page="dictionary"]').click();
  await page
    .locator(".card")
    .filter({ has: page.getByText("DDL Inferred Model", { exact: true }) })
    .locator("[data-use-dictionary]")
    .click();
  await page.locator('[data-mode="debug"]').click();
  await page.locator('[data-param="body"]').click();
  await page.locator("#generate-body").click();
  await page.waitForFunction(() => {
    try {
      return (
        JSON.parse(document.querySelector("#body-code").value).status ===
        "ready"
      );
    } catch {
      return false;
    }
  });
  assert.equal(JSON.parse(await page.locator("#body-code").inputValue()).id, 7);
  await saveAndWait("#save-project");

  await page.locator('[data-page="dictionary"]').click();
  await page.locator("#add-dictionary").click();
  await page.locator("#dict-name").fill("XML Inferred Model");
  await page
    .getByText("从 JSON / XML / MySQL DDL 生成 Schema", { exact: true })
    .click();
  await page.locator("#model-source-format").selectOption("xml");
  const xmlDraft = await page.locator("#modal-json").inputValue();
  const xmlLeaks = [];
  const observeXML = (request) => {
    if (request.url().includes("model-xml-leak")) xmlLeaks.push(request.url());
  };
  page.on("request", observeXML);
  for (const [source, message] of [
    ["<root>", "XML格式错误"],
    [
      '<!DOCTYPE r [<!ENTITY x SYSTEM "' +
        fixtureURL +
        '/model-xml-leak">]><r>&x;</r>',
      "XML不允许DTD或实体声明",
    ],
  ]) {
    await page.locator("#model-json-sample").fill(source);
    await page.locator("#infer-model-schema").click();
    await page
      .locator("#model-infer-error")
      .getByText(message, { exact: false })
      .waitFor();
    assert.equal(await page.locator("#modal-json").inputValue(), xmlDraft);
  }
  await page
    .locator("#model-json-sample")
    .fill(
      '<root id="7"><item>one</item><item><![CDATA[two<3]]></item><flag>true</flag></root>',
    );
  await page.locator("#infer-model-schema").click();
  const xmlExpected = {
    root: { $: { id: "7" }, item: ["one", "two<3"], flag: "true" },
  };
  const xmlSchema = JSON.parse(await page.locator("#modal-json").inputValue());
  assert.deepEqual(xmlSchema.example, xmlExpected);
  assert.equal(xmlSchema.properties.root.properties.flag.type, "string");
  await page.locator("#modal-json").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/local-api-model-xml-preview.png" });
  assert.deepEqual(xmlLeaks, []);
  page.off("request", observeXML);
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await saveAndWait("#save-project");
  await page.reload();
  await page.locator('[data-page="dictionary"]').click();
  await page
    .locator(".card")
    .filter({ has: page.getByText("XML Inferred Model", { exact: true }) })
    .locator("[data-use-dictionary]")
    .click();
  await page.locator('[data-mode="debug"]').click();
  await page.locator('[data-param="body"]').click();
  await page.locator("#generate-body").click();
  await page.waitForFunction(() => {
    try {
      return (
        JSON.parse(document.querySelector("#body-code").value).root.flag ===
        "true"
      );
    } catch {
      return false;
    }
  });
  assert.deepEqual(
    JSON.parse(await page.locator("#body-code").inputValue()),
    xmlExpected,
  );
  await saveAndWait("#save-project");

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
  const sqliteWriteFile = path.join(root, "ui-write.db");
  const sqliteWriteFixture = new DatabaseSync(sqliteWriteFile);
  sqliteWriteFixture.exec("CREATE TABLE entries(value TEXT)");
  sqliteWriteFixture.close();
  const countSQLiteRows = () => {
    const db = new DatabaseSync(sqliteWriteFile, { readOnly: true });
    try {
      return db.prepare("SELECT count(*) AS n FROM entries").get().n;
    } finally {
      db.close();
    }
  };
  await page.locator("#db-path").fill(sqliteWriteFile);
  await page.locator("#db-sql").fill("INSERT INTO entries(value) VALUES (?)");
  await page.locator("#db-params").fill('["from-ui"]');
  await page.locator("#db-query").click();
  await page
    .locator("#db-result")
    .getByText("仅支持只读", { exact: false })
    .waitFor();
  assert.equal(countSQLiteRows(), 0);
  await page.locator("#db-write").check();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#db-query").click();
  assert.equal(countSQLiteRows(), 0);
  assert.equal(await page.locator("#db-write").isChecked(), false);
  await page.locator("#db-write").check();
  let releaseDatabaseWrite, databaseWriteReady;
  const databaseWriteGate = new Promise((resolve) => {
    releaseDatabaseWrite = resolve;
  });
  const databaseWriteStarted = new Promise((resolve) => {
    databaseWriteReady = resolve;
  });
  const gatedDatabaseRoute = async (route) => {
    const response = await route.fetch();
    databaseWriteReady();
    await databaseWriteGate;
    await route.fulfill({ response });
  };
  await page.route("**/api/projects/*/database", gatedDatabaseRoute);
  page.once("dialog", (dialog) => dialog.accept());
  try {
    await page.locator("#db-query").click();
    await databaseWriteStarted;
    assert.equal(await page.locator("#db-query").isDisabled(), true);
    assert.equal(await page.locator("#db-type").isDisabled(), true);
    assert.equal(await page.locator("#db-tls").isDisabled(), true);
    assert.equal(
      countSQLiteRows(),
      1,
      "exactly one real write while its acknowledgement is held",
    );
  } finally {
    releaseDatabaseWrite();
  }
  await page
    .locator("#db-result")
    .getByText('"committed": true', { exact: false })
    .waitFor();
  await page.unroute("**/api/projects/*/database", gatedDatabaseRoute);
  assert.equal(await page.locator("#db-type").isEnabled(), true);
  assert.equal(await page.locator("#db-tls").isEnabled(), true);
  assert.equal(countSQLiteRows(), 1);
  assert.equal(await page.locator("#db-write").isChecked(), false);
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-sqlite-write.png" });
  const sqliteWriteSQL = await page.locator("#db-sql").inputValue();
  await page.locator("#db-write").check();
  await page.locator("#db-type").selectOption("postgres");
  assert.equal(await page.locator("#db-write").isChecked(), false);
  assert.equal(await page.locator("#db-result").textContent(), "");
  await page.locator("#db-host").fill("127.0.0.1");
  await page.locator("#db-port").fill("5432");
  await page.locator("#db-name").fill("fixture");
  await page.locator("#db-user").fill("tester");
  await page.locator("#db-sql").fill("INSERT INTO entries(value) VALUES ($1)");
  await page.locator("#db-write").check();
  const postgresRequests = [];
  const recordDatabaseRequest = (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/database")
    )
      postgresRequests.push(request.url());
  };
  page.on("request", recordDatabaseRequest);
  page.once("dialog", async (dialog) => {
    assert.match(dialog.message(), /PostgreSQL.*127.0.0.1:5432\/fixture/);
    assert.match(dialog.message(), /序列与外部副作用不能回滚/);
    await dialog.dismiss();
  });
  await page.locator("#db-query").click();
  await page.waitForFunction(
    () => !document.querySelector("#db-write").checked,
  );
  assert.equal(
    postgresRequests.length,
    0,
    "cancel must not contact the database",
  );
  page.off("request", recordDatabaseRequest);
  await page.screenshot({ path: "/tmp/local-api-postgres-write.png" });
  await page.locator("#db-type").selectOption("mysql");
  assert.equal(await page.locator("#db-write-label").isVisible(), false);
  await page.locator("#db-type").selectOption("sqlite");
  await page.locator("#db-sql").fill(sqliteWriteSQL);

  await page.locator("#db-register").click();
  await page.locator("#db-connection-name").fill("UI SQLite session");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('.rail [data-page="apis"]').click();
  await page.getByRole("button", { name: "新建接口", exact: true }).click();
  await page.locator("#url").fill(fixtureURL + "/global-parameters");
  await page.locator('[data-param="before"]').click();
  await page.locator("#add-db-operation").click();
  await page
    .locator("#operation-db-sql")
    .fill('SELECT value AS "row.value" FROM entries LIMIT 1');
  await page.locator("#operation-db-path").fill('$.rows[0]["row.value"]');
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-edit-db-operation="0"]').evaluate((button) => {
    button.click();
    button.click();
  });
  await page.locator("#dialog").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#operation-db-sql").inputValue(),
    'SELECT value AS "row.value" FROM entries LIMIT 1',
  );
  assert.equal(
    await page.locator("#operation-db-path").inputValue(),
    '$.rows[0]["row.value"]',
  );
  await page.locator("#operation-db-parameters").fill("{}");
  await page.locator("#dialog-save").click();
  await page
    .locator("#toast")
    .getByText("绑定参数须为", { exact: false })
    .waitFor();
  assert.equal(await page.locator("#dialog").isVisible(), true);
  await page.keyboard.press("Escape");
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-edit-db-operation="0"]').click();
  await page.locator("#dialog").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#operation-db-parameters").inputValue(),
    "[]",
  );
  await page
    .locator("#operation-db-sql")
    .fill('SELECT value AS "row.value" FROM entries WHERE value = ?');
  await page.locator("#operation-db-parameters").fill('["from-ui"]');
  await page.locator("#dialog-save").click();
  await page.locator("#add-db-operation").click();
  await page.locator("#operation-db-sql").fill("SELECT 'extra' AS value");
  await page.locator("#operation-db-name").fill("extraValue");
  await page.locator("#dialog-save").click();
  await page.locator('[data-move-operation="1:-1"]').click();
  assert.match(
    await page.locator('[data-operation-index="0"] strong').innerText(),
    /extraValue/,
  );
  await page.locator('[data-toggle-db-operation="0"]').click();
  assert.equal(
    await page.locator('[data-toggle-db-operation="0"]').innerText(),
    "启用",
  );
  await page.locator('[data-toggle-db-operation="0"]').click();
  assert.equal(
    await page.locator('[data-toggle-db-operation="0"]').innerText(),
    "停用",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator('[data-remove-operation="0"]').click();
  assert.equal(await page.locator("[data-operation-index]").count(), 2);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('[data-remove-operation="0"]').click();
  assert.equal(await page.locator("[data-operation-index]").count(), 1);
  await page
    .locator("#script-code")
    .fill(
      'apt.setRequestHeader("X-Database-Fixture", apt.getVar("dbResult"));',
    );
  const databaseOperationReply = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const databaseOperationResult = await (await databaseOperationReply).json();
  assert.equal(
    databaseOperationResult.outcome,
    "passed",
    JSON.stringify(databaseOperationResult),
  );
  assert.equal(databaseOperationResult.extracted.dbResult, "from-ui");
  assert.equal(
    JSON.parse(databaseOperationResult.body).databaseValue,
    "from-ui",
  );
  await page.locator('[data-response="body"]').click();
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-database-operation.png" });
  await page.locator('.rail [data-page="settings"]').click();
  await page.locator('[data-page="database"]').click();
  await page.locator("#db-connections").click();
  await page.locator("[data-revoke-db]").click();
  await page
    .locator("#dialog-content")
    .getByText("已撤销", { exact: false })
    .waitFor();
  await page.locator("#dialog-save").click();
  await page.locator('.rail [data-page="apis"]').click();
  const revokedDatabaseReply = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  assert.match(
    (await (await revokedDatabaseReply).json()).error,
    /失效|未授权/,
  );
  await page.locator('.rail [data-page="settings"]').click();
  await page.locator('[data-page="database"]').click();
  await page.locator("#db-path").fill(sqliteWriteFile);
  await page.locator("#db-register").click();
  await page.locator("#db-connection-name").fill("UI SQLite replacement");
  await page.locator("#dialog-save").click();
  await page.locator('.rail [data-page="apis"]').click();
  await page.locator('[data-param="before"]').click();
  await page.locator('[data-edit-db-operation="0"]').click();
  assert.equal(await page.locator("#operation-db-connection").inputValue(), "");
  await page.locator("#dialog-save").click();
  await page
    .locator("#toast")
    .getByText("请明确选择", { exact: false })
    .waitFor();
  await page
    .locator("#operation-db-connection")
    .selectOption({ label: "UI SQLite replacement · sqlite" });
  await page.locator("#dialog-save").click();
  const reboundReply = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  assert.equal((await (await reboundReply).json()).outcome, "passed");

  await page.locator('[data-param="before"]').click();
  await page.locator("#edit-operations").click();
  await page.locator("#modal-json").fill("[]");
  await page.locator("#dialog-save").click();
  await page.locator("#script-code").fill("");
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
  const redisBeforeWrite = redisCommands.length;
  const redisHTTPRequests = [];
  const recordRedisHTTP = (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/database")
    )
      redisHTTPRequests.push(request.url());
  };
  page.on("request", recordRedisHTTP);
  await page.locator("#db-write").check();
  await page.locator("#db-sql").fill('["SET","","v"]');
  await page.locator("#db-query").click();
  await page.waitForFunction(
    () => !document.querySelector("#db-write").checked,
  );
  assert.equal(
    redisHTTPRequests.length,
    0,
    "invalid key consumes the one-shot grant without an HTTP request",
  );
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page
    .locator("#db-sql")
    .fill('["SET","ui-fixture","redis-written-value","XX","KEEPTTL"]');
  await page.locator("#db-query").click();
  await page
    .locator("#db-result")
    .getByText("只读", { exact: false })
    .waitFor();
  assert.equal(
    redisCommands.length,
    redisBeforeWrite,
    "default reads cannot send SET",
  );
  await page.locator("#db-write").check();
  page.once("dialog", async (dialog) => {
    assert(
      dialog
        .message()
        .includes("Redis：127.0.0.1:" + redisFixture.address().port + "/0"),
    );
    assert(dialog.message().includes('目标键："ui-fixture"'));
    assert.match(dialog.message(), /不能回滚/);
    assert.match(dialog.message(), /清除原TTL/);
    assert.match(dialog.message(), /磁盘持久化/);
    await dialog.dismiss();
  });
  await page.locator("#db-query").click();
  await page.waitForFunction(
    () => !document.querySelector("#db-write").checked,
  );
  assert.equal(
    redisCommands.length,
    redisBeforeWrite,
    "cancelled SET never reaches Redis",
  );
  assert.equal(
    redisHTTPRequests.length,
    1,
    "cancel adds no request after the default read rejection",
  );
  await page.locator("#db-write").check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#db-query").click();
  await page
    .locator("#db-result")
    .getByText('"applied": true', { exact: false })
    .waitFor();
  assert.equal(await page.locator("#db-write").isChecked(), false);
  assert.equal(redisCommands.length, redisBeforeWrite + 1);
  assert.equal(
    redisHTTPRequests.length,
    2,
    "only the confirmed write adds one request",
  );
  page.off("request", recordRedisHTTP);
  const redisAppliedBounds = await page
    .locator("#db-result")
    .evaluate((node) => {
      const at = node.textContent.indexOf('"applied": true');
      const range = document.createRange();
      range.setStart(node.firstChild, at);
      range.setEnd(node.firstChild, at + 15);
      const bounds = range.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom };
    });
  assert(
    redisAppliedBounds.top >= 44 &&
      redisAppliedBounds.bottom <= page.viewportSize().height - 25,
    "Redis write acknowledgement is immediately visible above the footer",
  );
  await page.screenshot({ path: "/tmp/local-api-redis-write.png" });
  await page.locator("#db-sql").fill('["GET","ui-fixture"]');
  await page.locator("#db-query").click();
  await page
    .locator("#db-result")
    .getByText("redis-written-value", { exact: false })
    .waitFor();
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
  await page.locator("#db-type").selectOption("clickhouse");
  assert.equal(
    await page.locator("#db-port").getAttribute("placeholder"),
    "8123",
  );
  assert.equal(await page.locator("#db-auth-source").isVisible(), false);
  assert.equal(await page.locator("#db-params").isVisible(), true);
  await page.locator("#db-port").fill(String(fixture.address().port));
  await page.locator("#db-name").fill("default");
  await page.locator("#db-sql").fill("SELECT {p0:String} AS value");
  await page.locator("#db-params").fill('["clickhouse-ui"]');
  await page.locator("#db-query").click();
  await page
    .locator("#db-result")
    .getByText("clickhouse-ui", { exact: false })
    .waitFor();
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-clickhouse-query.png" });

  await page.locator('.rail [data-page="settings"]').click();
  await page
    .locator('[data-settings-anchor="settings-global-parameters"]')
    .click();
  assert.equal(
    await page.locator("#recursive-folder-scopes").isChecked(),
    false,
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#recursive-folder-scopes").click();
  assert.equal(
    await page.locator("#recursive-folder-scopes").isChecked(),
    false,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#recursive-folder-scopes").check();
  await saveAndWait("#save");
  assert.equal(
    (await app.store.get(await page.locator("#project-select").inputValue()))
      .settings.recursiveFolderScopes,
    true,
  );
  await page.locator('[data-settings-anchor="settings-basic"]').click();
  await page
    .locator('[data-settings-anchor="settings-global-parameters"]')
    .click();
  assert.equal(
    await page.locator("#recursive-folder-scopes").isChecked(),
    true,
  );
  await page.screenshot({ path: "/tmp/local-api-recursive-scopes.png" });
  await page.locator("#recursive-folder-scopes").uncheck();
  await saveAndWait("#save");
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
  // A nested exact-scope path renders actual ancestors and moves atomically.
  await page.locator('[data-edit-folder="参数目录"]').click();
  await page.locator("#folder-name").fill("树父/子/参数目录");
  await page.locator("#dialog-save").click();
  await saveAndWait("#save");
  await page.locator('.rail [data-page="settings"]').click();
  await page
    .locator('[data-settings-anchor="settings-global-parameters"]')
    .click();
  assert.equal(
    await page.locator('#parameter-scope option[value="树父"]').count(),
    1,
  );
  assert.equal(
    await page.locator('#parameter-scope option[value="树父/子"]').count(),
    1,
  );
  await page.locator('.rail [data-page="apis"]').click();
  assert.equal(
    await page
      .locator('[data-tree-folder=""] > summary [data-edit-folder]')
      .count(),
    0,
  );
  assert.equal(
    await page
      .locator(
        '[data-tree-folder="树父"] [data-tree-folder="树父/子"] [data-tree-folder="树父/子/参数目录"]',
      )
      .count(),
    1,
  );
  await page.locator('[data-tree-folder="树父"] > summary').click();
  assert.equal(await page.locator(".tree-item.active").isVisible(), false);
  await page.locator("#locate-request").click();
  assert.equal(await page.locator(".tree-item.active").isVisible(), true);
  await page.locator('[data-edit-folder="树父"]').click();
  await page.locator("#folder-name").fill("树改名");
  await page.locator("#dialog-save").click();
  await saveAndWait("#save");
  await page.locator('[data-mode="design"]').click();
  assert.equal(
    await page.locator("#folder").inputValue(),
    "树改名/子/参数目录",
  );
  const nestedProject = await app.store.get(
    await page.locator("#project-select").inputValue(),
  );
  assert.equal(
    nestedProject.settings.folderParameters["树改名/子/参数目录"].headers[0]
      .value,
    "folder-value",
  );
  assert.equal(
    nestedProject.settings.folderParameters["树父/子/参数目录"],
    undefined,
  );
  await page.screenshot({ path: "/tmp/local-api-folder-tree.png" });
  // Move the leaf back; following existing assertions verify effective HTTP data.
  await page.locator('[data-edit-folder="树改名/子/参数目录"]').click();
  await page.locator("#folder-name").fill("参数目录");
  await page.locator("#dialog-save").click();
  await saveAndWait("#save");
  await page.locator('[data-mode="debug"]').click();
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
      `await $.ajax({url:'${fixtureURL}/auth',success:async()=>{await Promise.resolve();apt.setRequestHeader('x-shared-script','callback-ready');},complete:async()=>{await Promise.resolve();apt.setVar('ajaxComplete',true);}});apt.test('ajax-complete',()=>apt.expect(apt.getVar('ajaxComplete')).to.equal(true));`,
    );
  await page
    .locator('[data-shared-script="afterScript"]')
    .fill(
      'apt.setVar("shared-script-post","done"); apt.test("apt-response-browser",()=>{apt.response.to.be.success;apt.response.to.have.header("Content-Type");apt.expect(apt.response.json.sharedScript).to.equal("callback-ready");apt.expect(csv2array("name,age")[0]).to.deep.equal(["name","age"]);apt.expect(xml2Json("<a>ok</a>").a).to.equal("ok");});',
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

  // Hold File reads so navigation and newer choices can overtake older uploads.
  await page.evaluate(() => {
    window.originalFileRead = File.prototype.arrayBuffer;
    window.fileReadGates = [];
    File.prototype.arrayBuffer = function () {
      const selected = this;
      return new Promise((resolve) =>
        window.fileReadGates.push(async () =>
          resolve(await window.originalFileRead.call(selected)),
        ),
      );
    };
  });
  const createFileTarget = async (name) => {
    await page.locator("#add-request").click();
    await page.locator("#request-name").fill(name);
    await page.locator('[data-param="body"]').click();
    await page.locator('input[name="body-type"][value="form-data"]').check();
    await page.locator('[data-add-pair="form"]').click();
    await page.locator('[data-pair="form:0:key"]').fill("file");
    await page.locator('[data-field-type="0"]').selectOption("file");
  };
  await createFileTarget("Upload race source");
  await page.locator('[data-field-file="0"]').setInputFiles({
    name: "stale.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([1]),
  });
  await page.waitForFunction(() => window.fileReadGates.length === 1);
  await createFileTarget("Upload race destination");
  await page.evaluate(() => window.fileReadGates[0]());
  await saveAndWait("#save-project");
  const raceState = (
    await Promise.all((await app.store.list()).map((p) => app.store.get(p.id)))
  ).find((p) => p.requests.some((r) => r.name === "Upload race destination"));
  assert(raceState, "upload fixture project persisted");
  const raceProject = { id: raceState.id };
  assert.equal(
    raceState.requests.find((r) => r.name === "Upload race source").form[0]
      .filename,
    undefined,
  );
  assert.equal(
    raceState.requests.find((r) => r.name === "Upload race destination").form[0]
      .filename,
    undefined,
  );
  await page.locator('[data-field-file="0"]').setInputFiles({
    name: "older.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([2]),
  });
  await page.waitForFunction(() => window.fileReadGates.length === 2);
  await page.locator('[data-field-file="0"]').setInputFiles({
    name: "latest.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([255]),
  });
  await page.waitForFunction(() => window.fileReadGates.length === 3);
  await page.evaluate(() => window.fileReadGates[2]());
  await page.getByText("latest.bin", { exact: true }).waitFor();
  await page.evaluate(() => window.fileReadGates[1]());
  await saveAndWait("#save-project");
  const finalUpload = (await app.store.get(raceProject.id)).requests.find(
    (r) => r.name === "Upload race destination",
  ).form[0];
  assert.equal(finalUpload.filename, "latest.bin");
  assert.equal(finalUpload.value, "/w==");
  await page.evaluate(() => {
    File.prototype.arrayBuffer = window.originalFileRead;
  });
  await page.screenshot({ path: "/tmp/local-api-file-selection.png" });

  const formSchemaProject = await app.store.create(
    "Form schema browser fixture",
  );
  formSchemaProject.requests = importDocument({
    openapi: "3.1.0",
    paths: {
      "/form": {
        post: {
          summary: "Form schema fidelity",
          requestBody: {
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: { a: { type: "string" }, forbidden: false },
                  additionalProperties: false,
                },
                example: { a: "a", extra: "x", rename: "r", upload: "" },
              },
            },
          },
          responses: { 200: { description: "OK" } },
        },
      },
    },
  });
  await app.store.save(formSchemaProject);
  await page.reload();
  await page.locator("#project-select").selectOption(formSchemaProject.id);
  await page.waitForFunction(
    () =>
      document.querySelector("#request-name")?.value === "Form schema fidelity",
  );
  await page.locator('[data-param="body"]').click();
  await page.locator('[data-pair="form:2:value"]').fill("payload edit only");
  await saveAndWait("#save-project");
  let formState = await app.store.get(formSchemaProject.id);
  assert.equal(formState.requests[0].form[2].schemaDefined, false);
  assert.equal(
    Object.hasOwn(
      exportOpenAPI(formState).paths["/form"].post.requestBody.content[
        "multipart/form-data"
      ].schema.properties,
      "extra",
    ),
    false,
  );
  await page.locator('[data-define-pair="form:1"]').click();
  assert.equal(await page.locator("#modal-json").inputValue(), "false");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-define-pair="form:2"]').click();
  await page.locator("#modal-json").fill('{"type":"string","minLength":2}');
  await page.locator("#parameter-required").check();
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-pair="form:3:key"]').fill("renamed");
  await page.locator('[data-field-type="4"]').selectOption("file");
  await saveAndWait("#save-project");
  formState = await app.store.get(formSchemaProject.id);
  const formContract =
    exportOpenAPI(formState).paths["/form"].post.requestBody.content[
      "multipart/form-data"
    ].schema;
  assert.equal(formContract.additionalProperties, false);
  assert.deepEqual(formContract.required, ["extra"]);
  assert.deepEqual(formContract.properties.forbidden, { not: {} });
  assert.deepEqual(formContract.properties.extra, {
    type: "string",
    minLength: 2,
  });
  assert.deepEqual(formContract.properties.renamed, {});
  assert.deepEqual(formContract.properties.upload, {
    type: "string",
    format: "binary",
  });
  assert.equal(formState.requests[0].form[1].schema, false);
  for (const width of [1000, 1440]) {
    await page.setViewportSize({ width, height: 760 });
    const layout = await page
      .locator('[data-pair="form:0:key"]')
      .evaluate((input) => {
        const row = input.closest("tr"),
          buttons = [...row.querySelectorAll("button")].map((button) =>
            button.getBoundingClientRect(),
          ),
          select = row.querySelector("select").getBoundingClientRect(),
          value = row
            .querySelector('[data-pair="form:0:value"]')
            .getBoundingClientRect();
        return {
          height: row.getBoundingClientRect().height,
          buttonSpread:
            Math.max(...buttons.map((box) => box.top)) -
            Math.min(...buttons.map((box) => box.top)),
          valueOffset: Math.abs(select.top - value.top),
          overflow:
            row.closest("table").scrollWidth - row.closest("table").clientWidth,
        };
      });
    assert.ok(
      layout.height <= 64,
      `parameter row is too tall at ${width}: ${JSON.stringify(layout)}`,
    );
    assert.ok(
      layout.buttonSpread <= 2,
      `parameter actions must share a row: ${JSON.stringify(layout)}`,
    );
    assert.ok(
      layout.valueOffset <= 3,
      `field type and value must align: ${JSON.stringify(layout)}`,
    );
    assert.ok(
      layout.overflow <= 1,
      `parameter table must not overflow: ${JSON.stringify(layout)}`,
    );
  }
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.screenshot({ path: "/tmp/local-api-form-schema.png" });

  await page.locator("#import").click();
  await page.locator("#import-text").fill(
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Browser schema Mock", version: "1" },
      servers: [{ url: app.url }],
      paths: {
        "/schema-mock": {
          get: {
            summary: "Schema-only Mock",
            responses: {
              201: {
                description: "generated",
                content: {
                  "application/problem+json": {
                    schema: {
                      type: "object",
                      properties: {
                        source: { type: "string", enum: ["schema"] },
                      },
                      required: ["source"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  );
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  const schemaMockProjectId = await page
    .locator("#project-select")
    .inputValue();
  const schemaMockRequest = (
    await app.store.get(schemaMockProjectId)
  ).requests.find((item) => item.name === "Schema-only Mock");
  assert.deepEqual(schemaMockRequest.examples, []);
  await page.reload();
  await page.locator(`[data-request="${schemaMockRequest.id}"]`).click();
  await page.locator('[data-mode="mock"]').click();
  await page.locator("#use-mock").click();
  const generatedResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const generated = await (await generatedResponse).json();
  assert.equal(generated.status, 201, JSON.stringify(generated));
  assert.deepEqual(JSON.parse(generated.body), { source: "schema" });
  await page
    .locator(".response-body")
    .getByText('"source": "schema"', { exact: false })
    .waitFor();
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-schema-mock-response.png" });

  await page.locator('[data-mode="mock"]').click();
  await page.locator("#add-example").click();
  await page.locator("#ex-name").fill("Sandboxed HTML fixture");
  await page
    .locator("#ex-body")
    .fill(
      '<h1 id="isolation-fixture">Isolated Mock</h1><script>globalThis.__mockExecuted=true;fetch("/api/session?mock-isolation-probe=script")</script><img src="/api/session?mock-isolation-probe=image"><form action="/api/session"><input name="mock-isolation-probe" value="form"><button>Blocked form</button></form>',
    );
  await page.locator("#ex-headers").fill('{"content-type":"text/html"}');
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await saveAndWait();
  const isolationURL = await page.locator(".mock-url").inputValue();
  const isolationRequests = [];
  const recordIsolationProbe = (request) => {
    if (request.url.includes("mock-isolation-probe"))
      isolationRequests.push(request.url);
  };
  app.server.on("request", recordIsolationProbe);
  const isolatedPage = await page.context().newPage();
  try {
    const isolated = await isolatedPage.goto(isolationURL + "?example=0");
    assert.equal(isolated.status(), 200);
    assert.match(
      isolated.headers()["content-security-policy"],
      /(?:^|;)\s*sandbox\s*(?:;|$)/,
    );
    await isolatedPage.locator("#isolation-fixture").waitFor();
    assert.equal(
      await isolatedPage.evaluate(() => globalThis.__mockExecuted === true),
      false,
      "Mock document scripts must not run in the workbench origin",
    );
    await isolatedPage.getByRole("button", { name: "Blocked form" }).click();
    assert.equal(isolatedPage.url(), isolationURL + "?example=0");
    assert.deepEqual(
      isolationRequests,
      [],
      "Mock HTML must not issue script, image, or form probes to the session API",
    );
    await isolatedPage.screenshot({
      path: "/tmp/local-api-mock-isolation.png",
    });
  } finally {
    app.server.off("request", recordIsolationProbe);
    await isolatedPage.close();
  }
  assert.equal(
    await page.locator("#project-select").inputValue(),
    schemaMockProjectId,
  );

  await page.locator("#new-project").click();
  await page.locator("#new-name").fill("Response example roundtrip");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator("#import").click();
  await page.locator("#import-text").fill(
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Bound examples", version: "1" },
      servers: [{ url: app.url }],
      paths: {
        "/response-cases": {
          get: {
            summary: "Bound response examples",
            responses: {
              200: {
                description: "Response metadata",
                content: {
                  "application/json": {
                    schema: {},
                    examples: {
                      first: { value: { remove: true } },
                      second: {
                        value: false,
                        description: "retain description",
                        "x-retained": true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  );
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-mode="mock"]').click();
  assert.equal(await page.locator("[data-edit-example]").count(), 2);
  await page.locator('[data-edit-example="1"]').click();
  await page.locator("#ex-name").fill("Edited zero");
  await page.locator("#ex-body").fill("0");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('[data-delete-example="0"]').click();
  await saveAndWait();
  await page.locator('[data-mode="design"]').click();
  await page.locator("[data-response-schema]").first().click();
  await page.locator("#schema-response-status").fill("201");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await saveAndWait();
  const exampleExportDownload = page.waitForEvent("download");
  await page.locator("#export").click();
  await page.locator("#export-format").selectOption("openapi");
  await page.locator("#dialog-save").click();
  const exampleExportFile = await exampleExportDownload;
  const exampleExportDocument = JSON.parse(
    await readFile(await exampleExportFile.path(), "utf8"),
  );
  const exportedCases =
    exampleExportDocument.paths["/response-cases"].get.responses;
  assert.equal(Object.hasOwn(exportedCases, "200"), false);
  const exportedNamedCases =
    exportedCases[201].content["application/json"].examples;
  assert.deepEqual(Object.keys(exportedNamedCases), ["second"]);
  assert.deepEqual(exportedNamedCases.second, {
    value: 0,
    description: "retain description",
    "x-retained": true,
    summary: "Edited zero",
  });
  const reimportedCases = importDocument(exampleExportDocument).find(
    (item) => item.name === "Bound response examples",
  );
  assert.equal(reimportedCases.examples.length, 1);
  assert.equal(reimportedCases.examples[0].body, "0");
  assert.equal(reimportedCases.examples[0].status, 201);
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-mode="mock"]').click();
  await page.getByText("Edited zero · 201", { exact: true }).waitFor();
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-openapi-examples.png" });

  await page.locator('[data-mode="debug"]').click();
  await page.locator("#url").fill(fixtureURL + "/script-response-wire");
  await page.locator('[data-param="after"]').click();
  const derivedBody = {
    value: 0,
    html: '<img src="' + fixtureURL + '/response-mutation-leak">',
  };
  await page
    .locator("#script-code")
    .fill(
      "pm.response.setBody(" +
        JSON.stringify(derivedBody) +
        '); pm.response.setCode(200); pm.test("derived-view", () => { pm.expect(pm.response.json().value).to.equal(0); pm.expect(pm.response.originalCode()).to.equal(500); });',
    );
  await saveAndWait();
  const responseMutationReply = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const responseMutationResult = await (await responseMutationReply).json();
  assert.equal(responseMutationResult.status, 500);
  assert.equal(responseMutationResult.body, '{"wire":true}');
  assert.equal(responseMutationResult.outcome, "failed");
  assert.deepEqual(responseMutationResult.scriptResponse, {
    body: JSON.stringify(derivedBody),
    status: 200,
  });
  assert(
    responseMutationResult.assertions.some(
      (x) => x.name === "derived-view" && x.passed,
    ),
  );
  await page.waitForFunction(() => !document.querySelector("#send")?.disabled);
  await page.locator('[data-response="body"]').click();
  assert.match(await page.locator(".response pre").innerText(), /"wire": true/);
  await page.locator('[data-response="scriptResponse"]').click();
  assert.equal(
    await page.locator("#response-script-view").innerText(),
    JSON.stringify(derivedBody),
  );
  assert.equal(await page.locator("#response-script-view img").count(), 0);
  assert.match(
    await page.locator(".response").innerText(),
    /处理状态：200.*网络状态：500/,
  );
  assert.equal(responseMutationLeaks, 0);
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-response-mutation.png" });

  await page.locator("#add-request").click();
  await page.locator("#request-name").fill("Script form body");
  await page.locator("#method").selectOption("POST");
  await page
    .locator("#url")
    .fill("{{browser?host#part}}/script-form-body?drop=1#{{browser#fragment}}");
  await page.locator('[data-param="before"]').click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#script-dialect").selectOption("apipost8");
  await page
    .locator("#script-code")
    .fill(
      "pm.request.body.update({mode:'urlencoded',urlencoded:[{key:'tag',value:'first'},{key:'tag',value:'second'},{key:'skip',value:'hidden',disabled:true}]}); const form=pm.request.body.urlencoded; const formContext={value:'changed',seen:0};form.each(function(e){this.seen++;return false;},formContext);form.find(e=>e.key==='tag'&&e.value==='second').value=formContext.value; form.add({key:'中文',value:'空 格&=+'});form.add({key:'remove-by-member',value:'must not send'});form.remove(form.one('remove-by-member'));form.add({key:'remove-by-predicate',value:'must not send'});form.remove(function(e){return e.key===this.name;},{name:'remove-by-predicate'}); pm.test('form-readers', () => {pm.expect(form.toObject().tag).to.deep.equal(['first','changed']);pm.expect(formContext.seen).to.equal(1);pm.expect(form.filter(e=>e.key==='tag').map(e=>e.value)).to.deep.equal(['first','changed']);pm.expect(form.map(e=>e.key).length).to.equal(form.count());pm.expect(form.reduce(n=>n+1,0)).to.equal(form.count());});",
    );
  // The inline editor must be reachable without scrolling past long help text.
  for (const stage of ["after", "before"]) {
    await page.locator(`[data-param="${stage}"]`).click();
    const visibleCodeHeight = await page
      .locator("#script-code")
      .evaluate((input) => {
        const panel = input.closest(".request-panel");
        panel.scrollTop = 0;
        const a = input.getBoundingClientRect(),
          b = panel.getBoundingClientRect();
        return Math.max(
          0,
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
        );
      });
    assert.ok(
      visibleCodeHeight >= 100,
      `${stage} inline script editor has ${visibleCodeHeight}px visible`,
    );
  }
  const originalFormScript = await page.locator("#script-code").inputValue();
  const editorSideEffects = [];
  const recordEditorSideEffect = (request) => {
    if (
      ["POST", "PUT"].includes(request.method()) &&
      /\/projects\//.test(request.url())
    )
      editorSideEffects.push(request.url());
  };
  page.on("request", recordEditorSideEffect);
  for (const dismiss of ["Escape", "取消", "关闭"]) {
    await page.locator("#expand-script").click();
    assert.equal(
      await page.locator("#expanded-script-code").inputValue(),
      originalFormScript,
    );
    await page
      .locator("#expanded-script-code")
      .fill("throw Error('discarded draft')");
    await page.keyboard.press("Control+Enter");
    await page.keyboard.press("Control+s");
    if (dismiss === "Escape") await page.keyboard.press("Escape");
    else
      await page
        .locator("#dialog")
        .getByRole("button", { name: dismiss, exact: true })
        .click();
    await page.locator("#dialog").waitFor({ state: "hidden" });
    assert.equal(
      await page.locator("#script-code").inputValue(),
      originalFormScript,
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "expand-script",
    );
  }
  const expandedFormScript =
    "// 扩展编辑器应用后仍需手动保存和发送\n" +
    "pm.variables.set('browser?host#part'," +
    JSON.stringify(fixtureURL) +
    ");pm.variables.set('browser#fragment','ignored');pm.request.removeQueryParams('drop');\n" +
    "apt.setRequestHeader('x-helper',null);pm.setRequestHeader('x-remove',1);pm.removeRequestHeader('X-REMOVE');\n" +
    "pm.setRequestQuery('shortcut',false);pm.setRequestQuery('gone',1);pm.removeRequestQuery('gone');\n" +
    "pm.variables.set('browser+&=%query','中文');pm.request.addQueryParams('batch=a%2Bb&batch={{browser+&=%query}}');apt.request.addQueryParams([{key:'hidden-batch',value:'x',disabled:true},{key:'removed-batch',value:'x'}]);pm.request.removeQueryParams([{key:'removed-batch'}]);\n" +
    "pm.test.skip('pending form check', () => {throw Error('must not execute')});\n" +
    "pm.request.headers.add({key:'x-reader-disabled',value:'not sent',disabled:true});pm.request.headers.add({key:'x-live-entry',value:'before',description:'retained description'});const headerContext={value:'live',seen:0};pm.request.headers.each(function(e){this.seen++;return false;},headerContext);pm.request.headers.find(e=>e.key==='x-live-entry').value=headerContext.value;pm.request.headers.add({key:'X-Wire-Repeat',value:'first'});pm.request.headers.add({key:'x-wire-repeat',value:'before upsert'});pm.request.headers.upsert({key:'X-Wire-Repeat',value:'second'});pm.request.headers.add({key:'x-remove-member',value:'first'});const removable=pm.request.headers.one('x-remove-member');pm.request.headers.add({key:'x-remove-member',value:'second'});pm.request.headers.remove(removable);pm.request.headers.remove(function(e){return e.key===this.name;},{name:'x-remove-member'});\n" +
    "pm.test('registration-count', () => {pm.expect(pm.test.index()).to.equal(2);pm.expect(headerContext.seen).to.equal(1);pm.expect(pm.request.headers.one('x-live-entry').description).to.equal('retained description');pm.expect(pm.request.headers.filter(e=>e.key==='x-live-entry').length).to.equal(1);pm.expect(pm.request.headers.map(e=>e.key).includes('x-live-entry')).to.equal(true);pm.expect(pm.request.headers.reduce((n)=>n+1,0)).to.equal(pm.request.headers.count());pm.expect(pm.request.getHeaders({enabled:true,ignoreCase:true})['x-helper']).to.equal('null');pm.expect(pm.request.getHeaders()['x-reader-disabled']).to.equal('not sent');pm.expect(apt.request.getHeaders({enabled:true})['x-reader-disabled']).to.equal(undefined);pm.expect(pm.request.headers.get('X-READER-DISABLED')).to.equal('not sent');pm.expect(pm.request.headers.has('x-reader-disabled','not sent')).to.equal(true);pm.expect(pm.request.headers.toObject()['x-reader-disabled']).to.equal('not sent');pm.expect(pm.request.headers.toObject(true)['x-reader-disabled']).to.equal(undefined);});\n" +
    originalFormScript.replaceAll("; ", ";\n") +
    "\npm.setRequestBody({modern:'body'},undefined,false);pm.setRequestBody('temporary',1);pm.removeRequestBody('temporary');";
  await page.locator("#expand-script").click();
  await page.locator("#expanded-script-code").fill(expandedFormScript);
  const expandedBounds = await page
    .locator("#expanded-script-code")
    .boundingBox();
  assert(expandedBounds.height > 250);
  assert(expandedBounds.width > 600);
  await page.screenshot({ path: "/tmp/local-api-expanded-script.png" });
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.equal(
    await page.locator("#script-code").inputValue(),
    expandedFormScript,
  );
  await page.locator("#expand-script").click();
  assert.equal(
    await page.locator("#expanded-script-code").inputValue(),
    expandedFormScript,
  );
  await page.keyboard.press("Escape");
  await page.locator('[data-param="after"]').click();
  await page.locator("#expand-script").click();
  assert.equal(await page.locator("#expanded-script-code").inputValue(), "");
  await page
    .locator("#expanded-script-code")
    .fill("throw Error('not applied')");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#script-code").inputValue(), "");
  await page.locator('[data-param="before"]').click();
  assert.equal(
    await page.locator("#script-code").inputValue(),
    expandedFormScript,
  );
  assert.deepEqual(editorSideEffects, []);
  page.off("request", recordEditorSideEffect);
  await saveAndWait();
  const scriptFormReply = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const scriptFormResult = await (await scriptFormReply).json();
  assert.equal(
    scriptFormResult.outcome,
    "passed",
    JSON.stringify(scriptFormResult),
  );
  const scriptFormWire = JSON.parse(scriptFormResult.body);
  assert.equal(scriptFormWire.liveHeader, "live");
  assert.equal(scriptFormWire.repeatedHeader, "first, second");
  assert.equal(
    new URL(scriptFormWire.url, fixtureURL).searchParams.has("drop"),
    false,
  );
  assert.deepEqual(
    new URL(scriptFormWire.url, fixtureURL).searchParams.getAll("batch"),
    ["a+b", "中文"],
  );
  assert.equal(
    new URL(scriptFormWire.url, fixtureURL).searchParams.has("hidden-batch"),
    false,
  );
  assert.equal(
    new URL(scriptFormWire.url, fixtureURL).searchParams.has("removed-batch"),
    false,
  );

  assert.equal(scriptFormWire.helper, "null");
  assert.equal(scriptFormWire.removed, null);
  assert.equal(scriptFormWire.readerDisabled, null);
  assert.equal(scriptFormWire.removedMember, null);
  assert.equal(
    new URL(scriptFormWire.url, fixtureURL).searchParams.get("shortcut"),
    "false",
  );
  assert.equal(
    new URL(scriptFormWire.url, fixtureURL).searchParams.has("gone"),
    false,
  );

  assert.deepEqual(scriptFormWire.pairs, [
    ["tag", "first"],
    ["tag", "changed"],
    ["中文", "空 格&=+"],
    ["modern", "body"],
  ]);
  assert.match(
    scriptFormWire.contentType,
    /application\/x-www-form-urlencoded/,
  );
  assert(
    scriptFormResult.assertions.some(
      (x) => x.name === "form-readers" && x.passed,
    ),
  );
  await page.waitForFunction(() => !document.querySelector("#send")?.disabled);
  await page.locator('[data-response="body"]').click();
  assert.match(await page.locator(".response pre").innerText(), /changed/);
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-script-form.png" });
  assert(
    scriptFormResult.assertions.some(
      (item) => item.name === "pending form check" && item.skipped === true,
    ),
  );
  await page.locator('[data-response="assertions"]').click();
  assert.match(
    await page.locator(".assertion-counts").innerText(),
    /通过 2 · 失败 0 · 跳过 1/,
  );
  await page.screenshot({ path: "/tmp/local-api-skipped-assertion.png" });

  await page.locator("#add-request").click();
  await page.locator("#request-name").fill("Query flag options");
  await page.locator("#method").selectOption("POST");
  await page.locator("#url").fill(fixtureURL + "/script-form-body");
  await page.locator('[data-param="query"]').click();
  await page.locator('[data-add-pair="query"]').click();
  await page.locator('[data-pair="query:0:key"]').fill("flag");
  await page.locator("#query-add-equal").uncheck();
  await saveAndWait();
  const flagRequestId = await page
    .locator("#tree [data-request]")
    .filter({ hasText: "Query flag options" })
    .getAttribute("data-request");
  await page.reload();
  await page.locator(`[data-request="${flagRequestId}"]`).click();
  await page.locator('[data-mode="debug"]').click();
  await page.locator('[data-param="query"]').click();
  assert.equal(await page.locator("#query-add-equal").isChecked(), false);
  for (const addEqual of [false, true]) {
    await page.locator("#query-add-equal").setChecked(addEqual);
    const reply = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
    );
    await page.locator("#send").click();
    const result = await (await reply).json();
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(
      JSON.parse(result.body).url,
      "/script-form-body?flag" + (addEqual ? "=" : ""),
    );
    await page.locator("#send:not([disabled])").waitFor();
  }
  await saveAndWait();
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-query-equals.png" });
  await page.locator('[data-param="cookies"]').click();
  await page.locator("#cookie-encoding").selectOption("apipost");
  await page.locator('[data-add-pair="cookies"]').click();
  await page.locator('[data-pair="cookies:0:key"]').fill("中文");
  await page.locator('[data-pair="cookies:0:value"]').fill("空 格+");
  await saveAndWait();
  await page.reload();
  await page.locator(`[data-request="${flagRequestId}"]`).click();
  await page.locator('[data-mode="debug"]').click();
  await page.locator('[data-param="cookies"]').click();
  assert.equal(await page.locator("#cookie-encoding").inputValue(), "apipost");
  const cookieReply = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const cookieResult = await (await cookieReply).json();
  assert.equal(cookieResult.status, 200, JSON.stringify(cookieResult));
  assert.equal(
    JSON.parse(cookieResult.body).cookie,
    "%E4%B8%AD%E6%96%87=%E7%A9%BA%20%E6%A0%BC%2B",
  );
  await page.locator("#send:not([disabled])").waitFor();
  const cookieViewport = page.viewportSize();
  for (const width of [800, cookieViewport.width]) {
    await page.setViewportSize({ width, height: cookieViewport.height });
    const layout = await page.locator(".cookie-toolbar").evaluate((toolbar) => {
      const manager = toolbar
        .querySelector(".cookie-manager-row")
        .getBoundingClientRect();
      const field = toolbar
        .querySelector(".cookie-encoding-field")
        .getBoundingClientRect();
      const select = toolbar.querySelector("select").getBoundingClientRect();
      const bounds = toolbar.getBoundingClientRect();
      return {
        managerBottom: manager.bottom,
        fieldTop: field.top,
        selectRight: select.right,
        right: bounds.right,
        scroll: toolbar.scrollWidth,
        width: toolbar.clientWidth,
      };
    });
    assert.ok(
      layout.fieldTop >= layout.managerBottom + 7,
      JSON.stringify(layout),
    );
    assert.ok(layout.selectRight <= layout.right + 1, JSON.stringify(layout));
    assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout));
  }
  await page.screenshot({ path: "/tmp/local-api-cookie-encoding.png" });

  await createFileTarget("Document form fields");
  const privateUploadText = "DOC-UPLOAD-BYTES-DO-NOT-INLINE";
  const privateUploadBase64 = Buffer.from(privateUploadText).toString("base64");
  await page.locator('[data-field-file="0"]').setInputFiles({
    name: "documentation-privacy.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(privateUploadText),
  });
  await page.getByText("documentation-privacy.txt", { exact: false }).waitFor();
  await page.locator('[data-add-pair="form"]').click();
  await page.locator('[data-pair="form:1:key"]').fill("display|name");
  await page
    .locator('[data-pair="form:1:value"]')
    .fill('<img src="' + fixtureURL + '/document-leak"> & literal');
  await page.locator('[data-pair-enabled="form:1"]').uncheck();
  await saveAndWait();
  await page.locator('[data-page="docs"]').click();
  const documentFormCard = page.locator("article.card").filter({
    has: page.getByRole("heading", {
      name: "Document form fields",
      exact: true,
    }),
  });
  const previewText = await documentFormCard.innerText();
  assert(previewText.includes("documentation-privacy.txt"));
  assert(previewText.includes("display|name"));
  assert(previewText.includes("停用"));
  assert(!previewText.includes(privateUploadText));
  assert(!previewText.includes(privateUploadBase64));
  assert.equal(await documentFormCard.locator("img").count(), 0);
  const documentTable = documentFormCard.locator(".doc-table-scroll");
  await documentTable.focus();
  assert(
    await documentTable.evaluate((node) => node.scrollWidth > node.clientWidth),
  );
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    (node) => node.scrollLeft > 0,
    await documentTable.elementHandle(),
  );
  assert(await documentTable.evaluate((node) => node.scrollLeft > 0));
  assert(
    await documentFormCard
      .locator("td:nth-child(4)")
      .first()
      .evaluate((node) => getComputedStyle(node).whiteSpace === "nowrap"),
  );
  await documentTable.evaluate(async (node) => {
    let previous = -1,
      stable = 0;
    for (let frame = 0; stable < 4 && frame < 120; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      stable = node.scrollLeft === previous ? stable + 1 : 0;
      previous = node.scrollLeft;
    }
    if (stable < 4) throw Error("Table scrolling did not settle");
    node.scrollTo({ left: 0, behavior: "instant" });
  });
  await documentFormCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/local-api-document-form-preview.png" });
  const htmlDocumentDownload = page.waitForEvent("download");
  await page.locator("#export-docs").click();
  await page.locator("#document-format").selectOption("html");
  await page.locator("#dialog-save").click();
  const htmlDocument = await readFile(
    await (await htmlDocumentDownload).path(),
    "utf8",
  );
  assert(!htmlDocument.includes(privateUploadText));
  assert(!htmlDocument.includes(privateUploadBase64));
  const documentPage = await browserContext.newPage();
  const documentRequests = [],
    documentErrors = [];
  documentPage.on("request", (request) => documentRequests.push(request.url()));
  documentPage.on("pageerror", (error) => documentErrors.push(error.message));
  try {
    await documentPage.setContent(htmlDocument);
    const exportedForm = documentPage.locator("section").filter({
      has: documentPage.getByRole("heading", {
        name: "Document form fields",
        exact: true,
      }),
    });
    const exportedText = await exportedForm.innerText();
    assert(exportedText.includes("documentation-privacy.txt"));
    assert(exportedText.includes("display|name"));
    assert(exportedText.includes("停用"));
    assert.equal(await documentPage.locator("img,script").count(), 0);
    assert.deepEqual(documentRequests, []);
    assert.deepEqual(documentErrors, []);
    await documentPage.setViewportSize({ width: 600, height: 800 });
    const exportedTable = exportedForm.locator(".doc-table-scroll");
    await exportedTable.focus();
    assert(
      await exportedTable.evaluate(
        (node) => node.scrollWidth > node.clientWidth,
      ),
    );
    await documentPage.keyboard.press("ArrowRight");
    await documentPage.waitForFunction(
      (node) => node.scrollLeft > 0,
      await exportedTable.elementHandle(),
    );
    assert(
      await documentPage.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await exportedTable.evaluate(async (node) => {
      let previous = -1,
        stable = 0;
      for (let frame = 0; stable < 4 && frame < 120; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        stable = node.scrollLeft === previous ? stable + 1 : 0;
        previous = node.scrollLeft;
      }
      if (stable < 4) throw Error("Table scrolling did not settle");
      node.scrollTo({ left: 0, behavior: "instant" });
    });
    await exportedForm.scrollIntoViewIfNeeded();
    await documentPage.screenshot({
      path: "/tmp/local-api-document-form-export.png",
    });
  } finally {
    await documentPage.close();
  }
  await page.locator("#dialog").waitFor({ state: "hidden" });
  const markdownDocumentDownload = page.waitForEvent("download");
  await page.locator("#export-docs").click();
  await page.locator("#document-format").selectOption("markdown");
  await page.locator("#dialog-save").click();
  const markdownDocument = await readFile(
    await (await markdownDocumentDownload).path(),
    "utf8",
  );
  const renderedMarkdownDocument = new MarkdownIt().render(markdownDocument);
  assert(renderedMarkdownDocument.includes("documentation-privacy.txt"));
  assert(renderedMarkdownDocument.includes("display|name"));
  assert(markdownDocument.includes("停用"));
  assert(!markdownDocument.includes(privateUploadText));
  assert(!markdownDocument.includes(privateUploadBase64));
  await page.locator("#dialog").waitFor({ state: "hidden" });

  await page.locator("#new-project").click();
  await page.locator("#new-name").fill("SDK URL mode fixture");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('.rail [data-page="apis"]').click();
  await page.locator("#add-request").click();
  await page.locator("#request-name").fill("SDK URL object request");
  await page
    .locator("#url")
    .fill(fixtureURL + "/sdk-url/{id}?raw=%2f+&x=1&x=2");
  await page.locator('[data-param="query"]').click();
  await page.locator('[data-add-pair="query"]').click();
  await page.locator('[data-pair="query:0:key"]').fill("table");
  await page.locator('[data-pair="query:0:value"]').fill("a+b");
  await page.locator('[data-param="before"]').click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#script-url-mode").selectOption("sdk");
  assert.equal(await page.locator("#script-url-mode").inputValue(), "string");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#script-url-mode").selectOption("sdk");
  await page.locator("#inherit-shared-scripts").uncheck();
  await page
    .locator("#script-code")
    .fill(
      "pm.request.url.variables.upsert({key:'id',value:'42'});pm.request.url.query.one('x').value='changed';",
    );
  await page.locator('[data-param="after"]').click();
  await page
    .locator("#script-code")
    .fill(
      "pm.test('SDK URL object',()=>{pm.expect(typeof pm.request.url).to.equal('object');pm.expect(pm.request.url.query.get('table')).to.equal('a+b');});",
    );
  await saveAndWait();
  const sdkRequestId = await page
    .locator("#tree [data-request]")
    .filter({ hasText: "SDK URL object request" })
    .getAttribute("data-request");
  await page.reload();
  await page.locator(`[data-request="${sdkRequestId}"]`).click();
  await page.locator('[data-mode="debug"]').click();
  await page.locator('[data-param="after"]').click();
  assert.equal(await page.locator("#script-url-mode").inputValue(), "sdk");
  const sdkReply = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const sdkResult = await (await sdkReply).json();
  assert.equal(sdkResult.outcome, "passed", JSON.stringify(sdkResult));
  assert.equal(
    JSON.parse(sdkResult.body).url,
    "/sdk-url/42?raw=%2f+&x=1&x=changed&table=a%2Bb",
  );
  assert(
    sdkResult.assertions.some(
      (item) => item.name === "SDK URL object" && item.passed,
    ),
  );
  // The execute response precedes the app's project refresh and final render.
  // Wait for that lifecycle, then select and measure the live DOM in one turn.
  await page.locator("#send:not([disabled])").waitFor({ state: "visible" });
  for (const width of [800, 1328]) {
    await page.setViewportSize({ width, height: 876 });
    const layout = await page.evaluate(() => {
      const groups = document.querySelectorAll(".script-mode-controls");
      if (groups.length !== 1)
        throw Error(
          "Expected exactly one script mode control group after completed request",
        );
      const group = groups[0];
      const fields = [...group.querySelectorAll("label")].map((field) => {
        const box = field.getBoundingClientRect();
        const select = field.querySelector("select").getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          selectLeft: select.left,
          selectRight: select.right,
        };
      });
      return { fields, width: group.clientWidth, scroll: group.scrollWidth };
    });
    assert.ok(layout.width > 0, JSON.stringify(layout));
    assert.equal(layout.fields.length, 2);
    const [first, second] = layout.fields;
    assert.ok(
      second.left >= first.right + 11 || second.top >= first.bottom + 11,
      JSON.stringify(layout),
    );
    for (const field of layout.fields) {
      assert.ok(
        field.selectLeft >= field.left - 1 &&
          field.selectRight <= field.right + 1,
        JSON.stringify(layout),
      );
    }
    assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout));
  }
  await page.screenshot({ path: "/tmp/local-api-sdk-url-mode.png" });
  await page.locator("#export").click();
  await page.locator("#export-format").selectOption("native");
  const sdkDownload = page.waitForEvent("download");
  await page.locator("#dialog-save").click();
  const sdkBackup = JSON.parse(
    await readFile(await (await sdkDownload).path(), "utf8"),
  );
  const sdkSaved = sdkBackup.requests.find(
    (request) => request.id === sdkRequestId,
  );
  assert.equal(sdkSaved.scriptURLMode, "sdk");
  assert.equal(sdkSaved.query[0].value, "a+b");
  assert.equal(sdkSaved.scriptURLRuntime, undefined);
  await page.locator("#dialog").waitFor({ state: "hidden" });
  // Export the definition without executing its earlier mutation script.
  await page.locator('[data-param="before"]').click();
  await page.locator("#script-code").fill("");
  await page.locator("#url").fill(fixtureURL + "/sdk-url/42?raw=%2f+&x=1&x=2");
  await page.locator("#curl").click();
  await page.locator("#curl-output").waitFor();
  assert.ok(
    (await page.locator("#curl-output").inputValue()).includes(
      "/sdk-url/42?raw=%2f+&x=1&x=2&table=a%2Bb",
    ),
  );
  await page.screenshot({ path: "/tmp/local-api-sdk-url-curl.png" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await page.locator("#method").selectOption("POST");
  await page.locator("#url").fill(fixtureURL + "/final-body");
  await page.locator('[data-param="body"]').click();
  await page.locator('input[name="body-type"][value="raw"]').check();
  await page.locator("#raw-format").selectOption("raw");
  await page.locator("#body-code").fill("{{payload}}");
  await page.locator('[data-param="before"]').click();
  await page
    .locator("#script-code")
    .fill(
      "pm.variables.set('payload','{{literal}}+&');const bytes=pm.getFinalRequestRawBody();pm.setRequestHeader('x-final-signature',CryptoJS.HmacSHA256(bytes,'fixture-key').toString());",
    );
  await page.locator('[data-param="after"]').click();
  await page
    .locator("#script-code")
    .fill(
      "pm.test('final-body-wire',()=>{pm.expect(pm.response.json().body).to.equal('{{literal}}+&');pm.expect(typeof pm.getFinalRequestRawBody).to.equal('undefined');});",
    );
  const finalBodyResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/execute"),
  );
  await page.locator("#send").click();
  const finalBodyPayload = await (await finalBodyResponse).json();
  assert.equal(
    finalBodyPayload.outcome,
    "passed",
    JSON.stringify(finalBodyPayload),
  );
  const finalBodyEcho = JSON.parse(finalBodyPayload.body);
  assert.equal(finalBodyEcho.body, "{{literal}}+&");
  assert.equal(
    finalBodyEcho.signature,
    createHmac("sha256", "fixture-key").update("{{literal}}+&").digest("hex"),
  );
  await page.locator("#send:not([disabled])").waitFor({ state: "visible" });
  await page.screenshot({ path: "/tmp/local-api-final-body.png" });
  // Sending uses an execution snapshot, not a save. Persist before switching
  // projects so the unsaved-change confirmation cannot cancel the switch.
  await saveAndWait();

  await page.locator("#new-project").click();
  await page.locator("#new-name").fill("OpenAPI URL query fixture");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.equal(
    await page.locator("#project-select option:checked").textContent(),
    "OpenAPI URL query fixture",
  );
  await page.locator('.rail [data-page="apis"]').click();
  await page.locator("#add-request").click();
  await page.locator("#request-name").fill("Literal URL query definition");
  await page.locator("#url").fill(fixtureURL + "/items?q=one+two&empty=");
  await page.locator('[data-param="query"]').click();
  await page.locator('[data-add-pair="query"]').click();
  await page.locator('[data-pair="query:0:key"]').fill("table");
  await page.locator('[data-pair="query:0:value"]').fill("a+b");
  await saveAndWait();
  await page.locator("#export").click();
  await page.locator("#export-format").selectOption("openapi");
  const queryDefinitionDownload = page.waitForEvent("download");
  await page.locator("#dialog-save").click();
  const queryDefinitionDocument = JSON.parse(
    await readFile(await (await queryDefinitionDownload).path(), "utf8"),
  );
  assert.deepEqual(
    queryDefinitionDocument.paths["/items"].get.parameters
      .filter((item) => item.in === "query")
      .map((item) => [item.name, item.example]),
    [
      ["q", "one two"],
      ["empty", ""],
      ["table", "a+b"],
    ],
  );
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.screenshot({ path: "/tmp/local-api-openapi-url-query.png" });

  // Restore the actual earlier imported project snapshot as a separate copy.
  // Restoration must not execute imported scripts or overwrite its source.
  const sourceBeforeRestore = await app.store.get(attributeProject.id);
  let restoreExecutions = 0;
  const countRestoreExecution = (request) => {
    if (request.method() === "POST" && request.url().endsWith("/execute"))
      restoreExecutions++;
  };
  page.on("request", countRestoreExecution);
  await page.locator("#import").click();
  await page.locator("#import-mode").selectOption("restore");
  await page.locator("#import-text").fill(JSON.stringify(attributeProject));
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  page.off("request", countRestoreExecution);
  assert.equal(restoreExecutions, 0);
  const restoredProjectId = await page.locator("#project-select").inputValue();
  assert.notEqual(restoredProjectId, attributeProject.id);
  assert.equal(
    await page.locator("#project-select option:checked").textContent(),
    attributeProject.name + " · 恢复副本",
  );
  const restoredProject = await app.store.get(restoredProjectId);
  assert.deepEqual(
    restoredProject.settings.attributes,
    attributeProject.settings.attributes,
  );
  assert.deepEqual(
    restoredProject.settings.statusCodes,
    attributeProject.settings.statusCodes,
  );
  assert.deepEqual(
    restoredProject.settings.parameterDescriptions,
    attributeProject.settings.parameterDescriptions,
  );
  const restoredAttributeRequest = restoredProject.requests.find(
    (request) => request.id === taskSourceRequest.id,
  );
  assert.deepEqual(
    restoredAttributeRequest.attributes,
    attributeRequest.attributes,
  );
  assert.deepEqual(
    restoredAttributeRequest.importedScriptTasks,
    taskSourceRequest.importedScriptTasks,
  );
  const sourceAfterRestore = await app.store.get(attributeProject.id);
  assert.deepEqual(sourceAfterRestore.requests, sourceBeforeRestore.requests);
  assert.deepEqual(sourceAfterRestore.settings, sourceBeforeRestore.settings);
  await page.locator('[data-page="docs"]').click();
  await page
    .locator(".error-code-document")
    .getByText("0007", { exact: true })
    .waitFor();
  await page.screenshot({ path: "/tmp/local-api-restored-modern-project.png" });

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
  await browserContext.close();
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
