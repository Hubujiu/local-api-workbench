import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createApp } from "../src/server.mjs";
import {
  exportOpenAPI,
  importDocument,
  normalizeRequest,
} from "../src/core.mjs";

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
  const generic = "application/problem+json";
  const profiled =
    'application/problem+json; profile="https://example.invalid/errors"';
  const [profileRequest] = importDocument({
    openapi: "3.1.0",
    info: { title: "Profiles", version: "1" },
    paths: {
      "/profiles": {
        get: {
          summary: "Profile verification",
          responses: {
            404: {
              description: "Profiled",
              content: {
                [generic]: {
                  examples: {
                    generic: {
                      summary: "Generic example",
                      value: { profile: false },
                    },
                  },
                },
                [profiled]: {
                  examples: {
                    profiled: {
                      summary: "Profiled example",
                      value: { profile: true },
                      "x-keep": true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  project.requests.push(request, profileRequest);
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
  const modes = page.getByRole("group", { name: "接口工作模式" });
  const environment = page.getByRole("combobox", { name: "执行环境" });
  const environmentSettings = page.getByRole("button", { name: "环境设置" });
  const verificationTab = page.locator(`[data-open-tab="${request.id}"]`);
  const profileTab = page.locator(`[data-open-tab="${profileRequest.id}"]`);
  await page.setViewportSize({ width: 360, height: 760 });
  await page.locator(`[data-request="${profileRequest.id}"]`).click();
  await profileTab.press("Enter");
  assert.equal(
    await profileTab.evaluate((el) => el === document.activeElement),
    true,
  );
  const strip = page.locator(".tab-scroll");
  const stripAfterSwitch = await strip.evaluate((el) => el.scrollLeft);
  assert(
    stripAfterSwitch > 0,
    "the active request tab must scroll into view: " +
      JSON.stringify(
        await strip.evaluate((el) => [el.clientWidth, el.scrollWidth]),
      ),
  );
  const stripBox = await strip.boundingBox();
  const environmentBox = await environment.boundingBox();
  assert(stripBox.x + stripBox.width <= environmentBox.x);
  assert(await environmentSettings.isVisible());
  const viewport = await page.evaluate(() => [
    innerWidth,
    document.documentElement.scrollWidth,
  ]);
  assert.equal(viewport[0], viewport[1]);
  await modes.getByRole("button", { name: "设计", exact: true }).press("Enter");
  assert.equal(await design.getAttribute("aria-pressed"), "true");
  assert.equal(
    await design.evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal(await strip.evaluate((el) => el.scrollLeft), stripAfterSwitch);
  await verificationTab.press("Enter");
  assert.equal(
    await verificationTab.evaluate((el) => el === document.activeElement),
    true,
  );
  await page.locator(`[data-close-tab="${profileRequest.id}"]`).press("Enter");
  assert.equal(await profileTab.count(), 0);
  assert.equal(
    await verificationTab.evaluate((el) => el === document.activeElement),
    true,
  );
  await page.setViewportSize({ width: 1363, height: 1023 });
  await debug.click();
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
  const examplesView = responseRegion.getByRole("button", {
    name: "示例",
    exact: true,
  });
  const schemaView = responseRegion.getByRole("button", {
    name: "数据结构",
    exact: true,
  });
  const settingsView = responseRegion.getByRole("button", {
    name: "期望设置",
    exact: true,
  });
  const applySettings = responseRegion.getByRole("button", {
    name: "应用响应设置",
    exact: true,
  });
  const settingsStatus = page.locator("#design-settings-status");
  const settingsDescription = page.locator("#design-settings-description");
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
    await responseTab(/404/).click();
    await examplesView.click();
    await page.mouse.move(1000, 282);
    await page.screenshot({
      path: responseScreenshots + "/candidate-design-response-404-example.png",
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
    await schemaView.click();
    await responseTab(/200/).click();
    await settingsView.click();
    for (const [status, key] of [
      [/200/, "200-settings"],
      [/404/, "404-settings"],
    ]) {
      await responseTab(status).click();
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
  const designHeader = panel.getByRole("textbox", { name: "新Header参数名" });
  assert.equal(
    await designHeader.evaluate((input) => input === document.activeElement),
    true,
  );
  await designHeader.fill("X-Verification");
  assert.equal(
    await pair("headers", "key").evaluate(
      (input) => input === document.activeElement,
    ),
    true,
  );
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
  await panel.getByRole("textbox", { name: "新Query参数名" }).fill("preview");
  assert.equal(await pair("query", "key").inputValue(), "preview");
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
  const headerEdit = page.getByRole("dialog", {
    name: "编辑响应头",
    exact: true,
  });
  await headerEdit
    .getByRole("textbox", { name: "响应头定义 JSON", exact: true })
    .fill('{"schema":{"type":"integer"}}');
  await headerEdit.press("Escape");
  await headerEdit.waitFor({ state: "hidden" });
  assert.deepEqual(
    JSON.parse(await rawResponses.inputValue()),
    JSON.parse(responseDraft),
  );
  await responseRegion
    .getByRole("button", { name: "使用 JSON 添加响应头" })
    .click();
  const headerAdd = page.getByRole("dialog", {
    name: "新增响应头",
    exact: true,
  });
  const headerName = headerAdd.getByRole("textbox", {
    name: "响应头名称",
    exact: true,
  });
  const headerJson = headerAdd.getByRole("textbox", {
    name: "响应头定义 JSON",
    exact: true,
  });
  await headerName.fill("x-trace");
  await headerAdd.locator("#dialog-save").click();
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
  await headerAdd.locator("#dialog-save").click();
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
  await examplesView.click();
  const addExample = responseRegion.getByRole("button", {
    name: "＋ 新建示例",
  });
  const exampleButton = responseRegion.getByRole("button", {
    name: "Missing JSON",
    exact: true,
  });
  await addExample.click();
  assert.equal(await page.locator("#ex-status").inputValue(), "404");
  assert.equal(await page.locator("#ex-status").getAttribute("readonly"), "");
  await page.locator("#ex-name").fill("Discarded");
  await page.locator("#dialog").press("Escape");
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.equal(
    await responseRegion.getByRole("button", { name: "Discarded" }).count(),
    0,
  );
  await addExample.click();
  await page.locator("#ex-name").fill("Missing JSON");
  await page.locator("#ex-body").fill("{");
  await page.locator("#dialog-save").click();
  await page.getByText("JSON 响应示例正文无效", { exact: true }).waitFor();
  await page.locator("#ex-body").fill('{"reason":"not-found"}');
  await page.locator("#dialog-save").click();
  await exampleButton.waitFor();
  await responseTab(/200/).click();
  assert.equal(await exampleButton.count(), 0);
  await responseTab(/404/).click();
  await exampleButton.waitFor();
  const sameMedia = responseRegion.getByRole("combobox", {
    name: "响应 Content-Type",
  });
  await sameMedia.selectOption("text/plain");
  assert.equal(await exampleButton.count(), 0);
  assert.equal(await addExample.count(), 0);
  await sameMedia.selectOption("application/json");
  await exampleButton.waitFor();
  await schemaView.click();
  await settingsView.click();
  await responseRegion
    .getByText("Missing JSON：0 ms", { exact: true })
    .waitFor();
  const settingsBefore = JSON.parse(await rawResponses.inputValue());
  await settingsDescription.fill("未提交");
  await settingsDescription.press("Escape");
  assert.equal(await applySettings.isDisabled(), true);
  assert.deepEqual(JSON.parse(await rawResponses.inputValue()), settingsBefore);
  await settingsStatus.fill("200");
  await applySettings.click();
  await page
    .getByText("此响应状态已存在，请编辑已有响应", { exact: true })
    .waitFor();
  assert.deepEqual(JSON.parse(await rawResponses.inputValue()), settingsBefore);
  await settingsStatus.fill("404");
  await settingsDescription.fill("保留响应结构");
  await applySettings.click();
  await responseTab(/保留响应结构.*404/).waitFor();
  assert.deepEqual(JSON.parse(await rawResponses.inputValue())[1], {
    ...settingsBefore[1],
    description: "保留响应结构",
  });
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
  let retained = JSON.parse(await rawResponses.inputValue())[1];
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

  const rootDescription = responseRegion.getByRole("button", {
    name: "编辑根节点描述",
  });
  const descriptionInput = responseRegion.getByRole("textbox", {
    name: "根节点描述",
  });
  const quickType = responseRegion.getByRole("button", {
    name: /^编辑根节点类型/,
  });
  const addRootField = responseRegion.getByRole("button", {
    name: "添加根字段",
  });
  const rootToggle = responseRegion.getByRole("button", {
    name: "根节点",
    exact: true,
  });
  const applyRoot = responseRegion.getByRole("button", {
    name: "应用到草稿",
    exact: true,
  });
  const focused = async (locator) =>
    locator.evaluate((element) => document.activeElement === element);
  const definitionsBeforeRoot = await rawResponses.inputValue();
  const narrow = { width: 360, height: 760 };
  await page.setViewportSize(narrow);
  assert.equal(
    await quickType.count(),
    0,
    "text example makes quick type unsafe",
  );
  await rootDescription.press("Enter");
  assert(await focused(descriptionInput));
  await descriptionInput.fill("discard-on-media-switch");
  await media.selectOption("application/json");
  assert.equal(await descriptionInput.count(), 0);
  assert.equal(await rawResponses.inputValue(), definitionsBeforeRoot);
  assert.equal(
    await quickType.count(),
    0,
    "managed JSON example also blocks quick type",
  );
  await media.selectOption("text/plain");
  await rootDescription.press("Enter");
  assert.equal(await descriptionInput.inputValue(), "");
  await descriptionInput.fill("discard-on-escape");
  await descriptionInput.press("Escape");
  assert(await focused(rootDescription));
  await rootDescription.press("Enter");
  await descriptionInput.fill("仅 text/plain\n<svg>文本</svg>");
  await applyRoot.click();
  assert(await focused(rootDescription));
  assert.equal(await rootDescription.locator("svg").count(), 0);
  assert.deepEqual(JSON.parse(await rawResponses.inputValue())[1], {
    ...retained,
    content: {
      ...retained.content,
      "text/plain": {
        ...retained.content["text/plain"],
        schema: {
          type: "string",
          description: "仅 text/plain\n<svg>文本</svg>",
        },
      },
    },
  });
  retained = JSON.parse(await rawResponses.inputValue())[1];

  await responseTab(/200/).click();
  assert.equal(await rootDescription.innerText(), "描述");
  const saveRootModal = page.locator("#dialog-save");
  const schemaTypes = page.getByRole("combobox", { name: "根类型" });
  const fieldInput = page.getByRole("textbox", { name: "根字段名称" });
  await quickType.press("Enter");
  assert(await focused(schemaTypes));
  assert.equal(
    await schemaTypes
      .locator("option")
      .filter({ hasText: /^(array|null)$/ })
      .count(),
    0,
  );
  await schemaTypes.selectOption("number");
  await schemaTypes.press("Escape");
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.id === "design-response-root-type",
  );
  assert.equal(await quickType.innerText(), "object");
  await quickType.press("Enter");
  await schemaTypes.selectOption("number");
  await saveRootModal.click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  assert.deepEqual(
    JSON.parse(await rawResponses.inputValue())[0].content["application/json"]
      .schema,
    {
      type: "number",
      properties: {},
    },
  );
  await quickType.press("Enter");
  await schemaTypes.selectOption("object");
  await saveRootModal.click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await addRootField.press("Enter");
  assert(await focused(fieldInput));
  await page
    .locator("#dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .press("Enter");
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.id === "design-response-root-add",
  );
  await quickType.press("Enter");
  // In one task, close the Type dialog natively and open Add. The old close
  // event must dispatch while Add is still open, not steal its focus return.
  assert.equal(
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const dialog = document.querySelector("#dialog");
          dialog.addEventListener("close", () => resolve(dialog.open), {
            once: true,
          });
          dialog.close();
          document.querySelector("#design-response-root-add").click();
        }),
    ),
    true,
  );
  assert(await focused(fieldInput));
  await fieldInput.fill("fixture-field");
  await saveRootModal.press("Enter");
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.id === "design-response-root-add",
  );
  const child = responseRegion.getByText("fixture-field", { exact: true });
  await child.waitFor();
  assert.equal(await rootToggle.getAttribute("aria-expanded"), "true");
  await rootToggle.press("Enter");
  await child.waitFor({ state: "hidden" });
  assert.equal(await rootToggle.getAttribute("aria-expanded"), "false");
  await responseTab(/404/).click();
  assert.equal(
    await rootToggle.count(),
    0,
    "disclosure belongs to the active media and status",
  );
  await responseTab(/200/).click();
  assert.equal(await rootToggle.getAttribute("aria-expanded"), "false");
  await rootToggle.press("Enter");
  await child.waitFor();
  assert.equal(
    await quickType.count(),
    0,
    "adding a field fences quick type conversion",
  );
  assert.deepEqual(JSON.parse(await rawResponses.inputValue())[1], retained);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    narrow.width,
  );
  assert.deepEqual(put, []);
  await page.setViewportSize({ width: 1363, height: 1023 });

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
  await responseRegion
    .getByRole("combobox", { name: "响应 Content-Type" })
    .selectOption("application/json");
  await examplesView.click();
  await exampleButton.waitFor();
  assert.equal(
    await responseRegion.locator(".design-example-row pre").innerText(),
    '{"reason":"not-found"}',
  );
  await headerView.click();
  await responseRegion
    .getByRole("button", { name: "编辑响应头 X-Reason" })
    .waitFor();
  const reloadedResponses = JSON.parse(await rawResponses.inputValue());
  assert.deepEqual(reloadedResponses[1], retained);
  assert.deepEqual(reloadedResponses[0].content["application/json"].schema, {
    type: "object",
    properties: { "fixture-field": { type: "string" } },
  });
  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  const openProfile = async () => {
    await page.locator(`[data-request="${profileRequest.id}"]`).click();
    await design.click();
    await bodyView.click();
    const media = responseRegion.getByRole("combobox", {
      name: "响应 Content-Type",
    });
    await media.selectOption(profiled);
    await examplesView.click();
    return media;
  };
  const profileMedia = await openProfile();
  const genericButton = responseRegion.getByRole("button", {
    name: "Generic example",
    exact: true,
  });
  const profiledButton = responseRegion.getByRole("button", {
    name: "Profiled example",
    exact: true,
  });
  await profiledButton.waitFor();
  assert.equal(await genericButton.count(), 0);
  await profiledButton.click();
  await page.locator("#ex-body").fill('{"profile":"edited"}');
  await page.locator("#dialog-save").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await profileMedia.selectOption(generic);
  await genericButton.waitFor();
  assert.deepEqual(
    JSON.parse(
      await responseRegion.locator(".design-example-row pre").innerText(),
    ),
    { profile: false },
  );
  assert.equal(await profiledButton.count(), 0);
  assert.deepEqual(put, ["PUT"]);
  await settingsView.click();
  await settingsStatus.fill("410");
  await settingsDescription.fill("Profiled migrated");
  await applySettings.click();
  await responseTab(/Profiled migrated.*410/).waitFor();
  assert.deepEqual(put, ["PUT"]);
  await page.locator("#save").click();
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  await page.reload();
  await openProfile();
  await profiledButton.waitFor();
  assert.equal(
    await responseRegion.locator(".design-example-row pre").innerText(),
    '{"profile":"edited"}',
  );
  const stored = await app.store.get(project.id);
  const exported = exportOpenAPI({
    ...stored,
    requests: stored.requests.filter((item) => item.id === profileRequest.id),
  });
  const exportedStatuses = exported.paths["/profiles"].get.responses;
  assert.equal(Object.hasOwn(exportedStatuses, "404"), false);
  const representations = exportedStatuses["410"].content;
  assert.deepEqual(representations[generic].examples.generic.value, {
    profile: false,
  });
  assert.deepEqual(representations[profiled].examples.profiled.value, {
    profile: "edited",
  });
  assert.equal(representations[profiled].examples.profiled["x-keep"], true);
  assert.deepEqual(put, ["PUT", "PUT"]);
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
