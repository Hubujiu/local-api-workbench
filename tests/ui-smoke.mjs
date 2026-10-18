import http from "node:http";
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
const fixture = http.createServer(async (request, response) => {
  if (request.url === "/sse") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: ui-stream-fixture\n\n");
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
  assert(await page.locator(".empty-symbol svg").isVisible());
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
  await page.screenshot({ path: "/tmp/local-api-step-editor.png" });
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-step-edit="0"]').click();
  assert.equal(
    await page.locator('[data-step-field="name"]').inputValue(),
    "独立快照步骤",
  );
  assert.equal(
    await page
      .locator('[data-step-pairs="headers"] [data-step-value]')
      .last()
      .inputValue(),
    "snapshot",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .getByRole("button", { name: "执行计划", exact: true })
    .last()
    .click();
  await page.getByText("✓ 通过", { exact: false }).waitFor();
  await page.screenshot({ path: "/tmp/local-api-plan.png" });
  // Exercise editable scripts, response evidence and repeated modal dismissal.
  await page.locator('[data-page="apis"]').click();
  await page.locator('[data-param="after"]').click();
  await page
    .locator("#script-code")
    .fill(
      'pm.environment.set("uiSaved","persisted"); pm.globals.set("uiGlobal",0); pm.test("payload", () => pm.expect(pm.response.code).to.equal(200)); console.log("script-done");',
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
  assert.equal(scopeSaved.globalVariables.uiGlobal, 0);
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
  await page.locator('[data-settings-anchor="resource-functions"]').click();
  await page.locator('[data-edit-resource="functions"]').click();
  await page
    .locator("#modal-json")
    .fill('[{"name":"double","body":"return args[0]*2;"}]');
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
  await page.reload();
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
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#dialog-save").click();
  const documentDownload = await downloadPromise;
  const documentText = await readFile(await documentDownload.path(), "utf8");
  assert(documentText.includes("Content-Security-Policy"));
  assert(documentText.includes("响应定义"));
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
  await page.context().tracing.stop({ path: "/tmp/local-api-trace.zip" });
  await browser.close();
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  await new Promise((r) => app.server.close(r));
  await rm(root, { recursive: true, force: true });
}
