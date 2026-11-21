import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const root = await mkdtemp("/tmp/workbench-design-pane-");
const app = await createApp({ root, port: 0 });
let browser;
try {
  const project = await app.store.create("设计页验证");
  const request = normalizeRequest({
    name: "Verification",
    method: "GET",
    bodyType: "none",
    responses: [
      {
        status: "200",
        description: "成功",
        content: {
          "application/json": { schema: { type: "object", properties: {} } },
        },
      },
      {
        status: "404",
        description: "失败",
        headers: { "X-Trace": { schema: { type: "string" } } },
        content: {
          "application/json": { schema: { type: "object", properties: {} } },
          "text/plain": { schema: { type: "string" }, example: "retain-me" },
        },
      },
    ],
    url: "http://127.0.0.1:38982/verification",
  });
  project.requests.push(request);
  await app.store.save(project);

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
  });
  const origin = new URL(app.launchUrl).origin;
  const put = [];
  const forbidden = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === origin && req.method() === "GET")
      return route.continue();
    if (
      url.origin === origin &&
      req.method() === "PUT" &&
      url.pathname === "/api/projects/" + project.id
    ) {
      put.push(req.method());
      return route.continue();
    }
    forbidden.push(req.method() + " " + url.pathname);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const design = page.locator('[data-mode="design"]');
  const debug = page.locator('[data-mode="debug"]');
  const descriptionSection = page.getByRole("region", {
    name: "详细说明",
    exact: true,
  });
  const disclosure = descriptionSection.locator(
    "#design-description > summary",
  );
  const description = page.getByRole("textbox", { name: "接口详细说明" });
  const tabs = page.getByRole("tablist", { name: "设计请求参数标签" });
  const tab = (name) => tabs.getByRole("tab", { name, exact: true });
  const panel = page.locator("#design-parameter-panel");
  const responseRegion = page.getByRole("region", {
    name: "设计响应参数",
    exact: true,
  });
  const responseTab = (name) => responseRegion.getByRole("tab", { name });
  const rawResponses = responseRegion.getByRole("textbox", {
    name: "响应定义 JSON",
  });
  const pair = (key, field) => panel.locator(`[data-pair="${key}:0:${field}"]`);
  const draft = "**说明草稿**\n\n<script>window.unexpected = true;</script>";
  await design.click();
  assert.equal(await description.count(), 0, "empty details start closed");
  assert.equal(await page.locator("#send").count(), 0, "design is not Debug");
  const heading = descriptionSection.getByRole("heading", {
    name: "详细说明",
    exact: true,
  });
  await disclosure.waitFor({ state: "visible" });
  const headingBox = await heading.boundingBox();
  const disclosureBox = await disclosure.boundingBox();
  assert(
    headingBox &&
      disclosureBox &&
      disclosureBox.y >= headingBox.y + headingBox.height,
    "the disclosure must be visible below the Design details heading",
  );
  await disclosure.press("Enter");
  const headerView = responseRegion.getByRole("button", {
    name: "Header",
    exact: true,
  });
  const bodyView = responseRegion.getByRole("button", {
    name: "Body",
    exact: true,
  });
  const responseScreenshots = process.env.DESIGN_RESPONSE_SCREENSHOTS;
  if (responseScreenshots) {
    await tab("Query").click();
    for (const [name, key] of [
      [/200/, "200-body"],
      [/404/, "404-body"],
    ]) {
      await responseTab(name).click();
      await page.mouse.move(1000, 282);
      await page.screenshot({
        path:
          responseScreenshots + "/candidate-design-response-" + key + ".png",
        clip: { x: 0, y: 0, width: 1363, height: 980 },
        caret: "hide",
        animations: "disabled",
      });
    }
    await responseTab(/200/).click();
    await headerView.click();
    await page.mouse.move(1000, 282);
    await page.screenshot({
      path: responseScreenshots + "/candidate-design-response-200-headers.png",
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
    await bodyView.click();
    await tab("Header").click();
  }
  const screenshotDirectory = process.env.DESIGN_PARAMETER_SCREENSHOTS;
  if (screenshotDirectory) {
    for (const [name, key] of [
      ["Header", "headers"],
      ["Query", "query"],
      ["Path", "path"],
      ["Body", "body"],
      ["认证", "auth"],
    ]) {
      await tab(name).click();
      await page.mouse.move(1000, 282);
      await page.screenshot({
        path: screenshotDirectory + "/candidate-design-param-" + key + ".png",
        clip: { x: 0, y: 0, width: 1363, height: 980 },
        caret: "hide",
        animations: "disabled",
      });
    }
    await tab("Header").click();
  }
  const toolbar = descriptionSection.getByRole("group", {
    name: "说明格式工具",
  });
  const original = "first line\nVerification";
  await description.press("End");
  await description.pressSequentially("first line");
  await description.press("Enter");
  await description.pressSequentially("Verification");
  await description.press("Home");
  await description.press("Shift+End");
  await toolbar.getByRole("button", { name: "加粗" }).click();
  assert.equal(await description.inputValue(), "first line\n**Verification**");
  assert.equal(
    await page.locator("#design-description-preview strong").innerText(),
    "Verification",
  );
  assert.equal(
    await description.evaluate((field) =>
      field.value.slice(field.selectionStart, field.selectionEnd),
    ),
    "Verification",
  );
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  const modifier = mac ? "Meta" : "Control";
  await description.press(modifier + "+z");
  assert.equal(
    await description.inputValue(),
    original,
    "undo only formatting",
  );
  assert.equal(
    await page.locator("#design-description-preview strong").count(),
    0,
  );
  assert.deepEqual(put, []);
  await description.press(modifier + "+Shift+z");
  assert.equal(
    await description.inputValue(),
    "first line\n**Verification**",
    "redo formatting",
  );
  assert.equal(
    await page.locator("#design-description-preview strong").innerText(),
    "Verification",
  );
  assert.deepEqual(put, []);
  if (process.env.DESIGN_TOOLBAR_SCREENSHOT) {
    await page.mouse.move(1000, 282);
    await page.screenshot({
      path: process.env.DESIGN_TOOLBAR_SCREENSHOT,
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  }
  await description.fill("keyboard");
  await description.selectText();
  await description.press("Control+i");
  assert.equal(await description.inputValue(), "*keyboard*");
  assert.deepEqual(put, []);
  await description.fill(draft);
  assert.equal(
    await page.locator("#design-description-preview strong").innerText(),
    "说明草稿",
  );
  assert.equal(
    await page.locator("#design-description-preview script").count(),
    0,
  );

  await page.locator("#request-design-preview").click();
  const dialog = page.locator("#dialog");
  await dialog.getByText("说明草稿", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  assert.deepEqual(put, []);
  assert.equal(await tab("Header").getAttribute("aria-selected"), "true");
  await panel.getByRole("button", { name: "＋ 添加参数" }).click();
  assert.equal(
    await pair("headers", "key").evaluate(
      (input) => input === document.activeElement,
    ),
    true,
  );
  await pair("headers", "key").fill("X-Verification");
  await pair("headers", "value").fill("draft-header");
  await tab("Header").press("ArrowRight");
  assert.equal(await tab("Query").getAttribute("aria-selected"), "true");
  assert.equal(
    await tab("Query").evaluate((input) => input === document.activeElement),
    true,
  );
  await panel
    .getByRole("checkbox", { name: "空值 Query 参数添加等号" })
    .uncheck();
  await panel.getByRole("button", { name: "＋ 添加参数" }).click();
  await pair("query", "key").fill("preview");
  await pair("query", "value").fill("draft-query");
  await tab("Path").click();
  await panel.getByRole("button", { name: "＋ 添加参数" }).click();
  await pair("path", "key").fill("id");
  await pair("path", "value").fill("sample-path");
  await tab("Body").click();
  await panel.getByText("当前请求未包含 Body", { exact: true }).waitFor();
  await panel.getByRole("radio", { name: "raw", exact: true }).check();
  await panel
    .getByRole("textbox", { name: "请求体" })
    .fill('{"state":"draft"}');
  await tab("Body").press("End");
  assert.equal(await tab("认证").getAttribute("aria-selected"), "true");
  await panel.locator("#auth-type").selectOption("bearer");
  await panel.locator('[data-auth="token"]').fill("synthetic-only");
  await tab("Header").click();
  assert.equal(await pair("headers", "value").inputValue(), "draft-header");
  await debug.click();
  assert.equal(
    await page.locator("[data-param].active").getAttribute("data-param"),
    "body",
  );
  await design.click();
  assert.equal(await description.inputValue(), draft);
  await tab("Body").click();
  assert.equal(
    await panel.getByRole("textbox", { name: "请求体" }).inputValue(),
    '{"state":"draft"}',
  );
  assert.deepEqual(put, []);

  await disclosure.press("Enter");
  assert.equal(await description.count(), 0);
  await page.setViewportSize({ width: 680, height: 760 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    680,
  );
  await disclosure.press("Enter");
  assert.equal(await description.inputValue(), draft);
  assert.equal(await page.locator("#visual-schema").count(), 1);
  const requestSchema = page.getByRole("textbox", { name: "请求 JSON Schema" });
  await requestSchema.fill('{"type":');
  await tab("Query").click();
  assert.equal(await tab("Body").getAttribute("aria-selected"), "true");
  assert.equal(await requestSchema.inputValue(), '{"type":');
  assert.deepEqual(put, []);
  await page
    .getByRole("textbox", { name: "请求 JSON Schema" })
    .fill('{"type":"object","description":"retained"}');
  await tab("Query").click();
  assert.equal(
    await panel
      .getByRole("checkbox", { name: "空值 Query 参数添加等号" })
      .isChecked(),
    false,
  );
  assert.equal(await pair("query", "value").inputValue(), "draft-query");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    680,
  );
  assert.equal(await page.locator("#new-response-schema").count(), 1);
  const responseDraft = await rawResponses.inputValue();
  await rawResponses.fill("[{");
  await responseTab(/404/).click();
  assert.equal(await responseTab(/200/).getAttribute("aria-selected"), "true");
  assert.equal(await rawResponses.inputValue(), "[{");
  await rawResponses.fill(responseDraft);
  await responseTab(/200/).press("ArrowRight");
  assert.equal(await responseTab(/404/).getAttribute("aria-selected"), "true");
  assert.equal(
    await responseTab(/404/).evaluate((e) => e === document.activeElement),
    true,
  );
  await headerView.click();
  await responseRegion
    .getByRole("button", { name: "编辑响应头 X-Trace" })
    .click();
  const headerJson = page.getByRole("textbox", { name: "响应头定义 JSON" });
  await headerJson.fill('{"schema":{"type":"integer"}}');
  await page.locator("#dialog").press("Escape");
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.deepEqual(
    JSON.parse(await rawResponses.inputValue()),
    JSON.parse(responseDraft),
  );
  await responseRegion.getByRole("button", { name: "＋ 添加响应头" }).click();
  const headerName = page.getByRole("textbox", { name: "响应头名称" });
  await headerName.fill("x-trace");
  await page.locator("#dialog-save").click();
  await page
    .getByText("同名响应头已存在（不区分大小写）", { exact: true })
    .waitFor();
  assert.deepEqual(
    JSON.parse(await rawResponses.inputValue()),
    JSON.parse(responseDraft),
  );
  await headerName.fill("X-Reason");
  await headerJson.fill(
    '{"description":"Synthetic failure","schema":{"type":"string","maxLength":80},"example":"not-found","x-retain":true}',
  );
  await page.locator("#dialog-save").click();
  await responseRegion
    .getByRole("button", { name: "编辑响应头 X-Reason" })
    .waitFor();
  await responseTab(/200/).click();
  assert.equal(await headerView.getAttribute("aria-pressed"), "true");
  assert.equal(
    await responseRegion
      .getByRole("button", { name: "编辑响应头 X-Reason" })
      .count(),
    0,
  );
  await responseTab(/404/).click();
  await responseRegion
    .getByRole("button", { name: "编辑响应头 X-Reason" })
    .waitFor();
  await bodyView.click();
  const responseAfterHeader = await rawResponses.inputValue();
  assert.deepEqual(put, []);
  const media = responseRegion.getByRole("combobox", {
    name: "响应 Content-Type",
  });
  await responseRegion.getByRole("button", { name: "编辑结构" }).click();
  const targetMedia = page.locator("#schema-response-media");
  await targetMedia.fill("Text/Plain");
  await page.locator("#dialog-save").click();
  await page
    .getByText("Content-Type 已存在，请切换到该类型后直接编辑", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#dialog").isVisible(), true);
  assert.deepEqual(
    JSON.parse(await rawResponses.inputValue()),
    JSON.parse(responseAfterHeader),
  );
  assert.deepEqual(put, []);
  await targetMedia.fill("application/problem+json");
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.equal(await media.inputValue(), "application/problem+json");
  await media.selectOption("text/plain");
  await responseRegion
    .locator(".design-response-kind")
    .getByText("string", { exact: true })
    .waitFor();
  await responseRegion.getByRole("button", { name: "编辑结构" }).click();
  await page.locator("#schema-response-description").fill("未找到");
  await page.locator("#dialog-save").click();
  await responseTab(/未找到.*404/).waitFor();
  assert.equal(await media.inputValue(), "text/plain");
  const retained = JSON.parse(await rawResponses.inputValue())[1];
  assert.equal(retained.content["text/plain"].example, "retain-me");
  assert.equal(retained.headers["X-Trace"].schema.type, "string");
  assert.deepEqual(retained.headers["X-Reason"], {
    description: "Synthetic failure",
    schema: { type: "string", maxLength: 80 },
    example: "not-found",
    "x-retain": true,
  });
  assert.equal(retained.content["application/json"].schema.type, "object");
  assert.equal(retained.content["text/plain"].schema.type, "string");
  assert.equal(
    retained.content["application/problem+json"].schema.type,
    "object",
  );
  assert.deepEqual(put, []);

  await page.locator("#save").click();
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  assert.deepEqual(put, ["PUT"]);
  await page.reload();
  await design.click();
  assert.equal(await description.inputValue(), draft);
  assert.equal(
    JSON.parse(
      await page
        .getByRole("textbox", { name: "请求 JSON Schema" })
        .inputValue(),
    ).description,
    "retained",
  );
  await tab("Header").click();
  assert.equal(await pair("headers", "key").inputValue(), "X-Verification");
  await tab("Query").click();
  assert.equal(await pair("query", "value").inputValue(), "draft-query");
  assert.equal(
    await panel
      .getByRole("checkbox", { name: "空值 Query 参数添加等号" })
      .isChecked(),
    false,
  );
  await tab("Path").click();
  assert.equal(await pair("path", "value").inputValue(), "sample-path");
  await tab("Body").click();
  assert.equal(
    await panel.getByRole("textbox", { name: "请求体" }).inputValue(),
    '{"state":"draft"}',
  );
  await tab("认证").click();
  assert.equal(
    await panel.locator('[data-auth="token"]').inputValue(),
    "synthetic-only",
  );
  assert.deepEqual(put, ["PUT"]);
  await responseTab(/未找到.*404/).click();
  await headerView.click();
  await responseRegion
    .getByRole("button", { name: "编辑响应头 X-Reason" })
    .waitFor();
  const reloadedResponses = JSON.parse(await rawResponses.inputValue());
  assert.deepEqual(reloadedResponses[1], retained);
  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  console.log(
    "HTTP_DESIGN_PANE_PASS undo/redo/parameter-tabs/draft/explicit-save/reload",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
