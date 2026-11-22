import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { preparePostmanCollection } from "../src/postman-collection-scopes.mjs";
import { createApp } from "../src/server.mjs";
import {
  chooseProjectSwitch,
  projectSwitchPrompt,
} from "./helpers/project-switch-confirmation-ui.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const root = await mkdtemp(join(tmpdir(), "workbench-debug-raw-body-"));
const original = '{"message":"local synthetic draft","enabled":true,"count":2}';
const formatted = [
  "{",
  '    "message": "local synthetic draft",',
  '    "enabled": true,',
  '    "count": 2',
  "}",
].join("\n");
const formattedTwoColumns = formatted.replace(/^ {4}/gm, "  ");
const palette = {
  key: "rgb(176, 30, 50)",
  string: "rgb(0, 89, 179)",
  literal: "rgb(0, 89, 179)",
  number: "rgb(8, 122, 82)",
};
const invalid = '{"message":}';
const near = (found, expected, delta, name) =>
  assert(
    Math.abs(found - expected) <= delta,
    `${name}: ${found} expected ${expected} ± ${delta}`,
  );
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("默认项目");
  const request = normalizeRequest({
    id: "verification",
    name: "Verification",
    url: "http://127.0.0.1:38982/verification",
    bodyType: "json",
  });
  project.requests.push(request);
  await app.store.save(project);
  const baseline = await app.store.get(project.id);
  const dictionaryProject = await app.store.create("字典参数本机验收");
  const dictionaryRequest = normalizeRequest({
    id: "dictionary-draft",
    name: "Dictionary draft",
    url: "http://127.0.0.1:38982/verification",
    bodyType: "json",
    body: original,
  });
  const owningCollection = preparePostmanCollection(
    {
      info: { name: "Owning fixture collection" },
      item: [],
      variable: [
        {
          key: "collectionOnlyName",
          value: "synthetic-collection-only-secret",
        },
        {
          key: "collectionShadowsGlobal",
          value: "synthetic-collection-winner-secret",
        },
        { key: "duplicatedName", value: "synthetic-collection-loser-secret" },
        { key: "definitionOnlyName", value: "synthetic-definition-secret" },
      ],
    },
    () => "helper-owning-collection",
  );
  delete owningCollection.variables.definitionOnlyName;
  const unrelatedCollection = preparePostmanCollection(
    {
      info: { name: "Other fixture collection" },
      item: [],
      variable: [
        {
          key: "unrelatedCollectionName",
          value: "synthetic-unrelated-collection-secret",
        },
      ],
    },
    () => "helper-other-collection",
  );
  dictionaryProject.postmanCollections = {
    version: 1,
    items: [unrelatedCollection, owningCollection],
  };
  dictionaryRequest.postmanCollectionId = owningCollection.id;
  dictionaryProject.requests.push(
    dictionaryRequest,
    normalizeRequest({
      id: "unbound-helper-draft",
      name: "Unbound helper draft",
      url: dictionaryRequest.url,
      bodyType: "json",
    }),
    normalizeRequest({
      id: "other-helper-draft",
      name: "Other collection helper draft",
      url: dictionaryRequest.url,
      bodyType: "json",
      postmanCollectionId: unrelatedCollection.id,
    }),
  );
  dictionaryProject.settings.builtinDictionary = false;
  dictionaryProject.globalVariables = {
    fixtureGlobalName: "synthetic-global-secret-value",
    duplicatedName: "synthetic-duplicate-global-secret",
    collectionShadowsGlobal: "synthetic-global-loser-secret",
  };
  Object.assign(dictionaryProject.environments[0].variables, {
    fixtureEnvironmentName: "synthetic-environment-secret-value",
    duplicatedName: "synthetic-duplicate-environment-secret",
  });
  dictionaryProject.environments.push({
    id: "unselected-helper-env",
    name: "Unselected fixture environment",
    variables: { unrelatedEnvironmentName: "synthetic-unselected-secret" },
  });
  dictionaryProject.parameterDictionary = [
    {
      id: "request-id",
      key: "requestId",
      type: "string",
      note: "only note",
      description: "公开追踪字段",
      default: "draft-only",
    },
    {
      id: "limit-field",
      key: "limit",
      type: "integer",
      note: "分组",
      description: "maximum page size",
      default: 25,
    },
  ];
  await app.store.save(dictionaryProject);
  const dictionaryBaseline = await app.store.get(dictionaryProject.id);
  const origin = new URL(app.launchUrl).origin;
  const blocked = [];
  const errors = [];
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
  page.setDefaultTimeout(6500);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((initialProject) => {
    sessionStorage.setItem("project", initialProject);
    localStorage.setItem("theme", "light");
    window.__bodyCopyEvents = [];
    document.addEventListener("copy", (event) => {
      const source = document.activeElement;
      window.__bodyCopyEvents.push(
        source?.id === "body-code"
          ? source.value.slice(source.selectionStart, source.selectionEnd)
          : source?.id,
      );
      // Exercise the native keyboard event without touching the host clipboard.
      event.preventDefault();
    });
  }, project.id);
  await page.route("**/*", (route) => {
    const req = route.request();
    if (req.method() === "GET" && new URL(req.url()).origin === origin)
      return route.continue();
    blocked.push([req.method(), new URL(req.url()).origin === origin]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  const editor = page.locator('.editor[data-editor-mode="debug"]');
  const bodyTab = editor.locator('.param-tabs [data-param="body"]');
  await bodyTab.click();
  const body = editor.locator("#body-code");
  const gutter = editor.locator("#code-gutter");
  const format = editor.getByRole("button", {
    name: "格式化 JSON",
    exact: true,
    includeHidden: true,
  });
  const generate = editor.getByRole("button", {
    name: "基于数据结构生成",
    exact: true,
  });
  const expand = editor.locator("#expand-body");
  const helperToggle = editor.getByRole("button", {
    name: "参数助手",
    exact: true,
  });
  const helperRailChevron = helperToggle.locator(".helper-rail-chevron");
  const helperPanel = editor.locator("#body-parameter-helper");
  const railFill = () =>
    helperToggle.evaluate((button) => getComputedStyle(button).backgroundColor);
  const measureClosedHelper = async () => {
    assert.equal(await helperToggle.getAttribute("aria-expanded"), "false");
    assert.equal(await helperPanel.count(), 0);
    assert(await helperRailChevron.isVisible());
    const rail = await helperToggle.boundingBox();
    const arrow = await helperRailChevron.boundingBox();
    const captions = await helperToggle
      .locator(".helper-label > span:not(.helper-rail-chevron)")
      .evaluateAll((spans) =>
        spans.map((span) => {
          const { x, y, width, height } = span.getBoundingClientRect();
          return { text: span.textContent, x, y, width, height };
        }),
      );
    assert.equal(await railFill(), "rgb(243, 235, 216)");
    assert.equal(
      await helperToggle.evaluate((button) => getComputedStyle(button).color),
      "rgb(111, 99, 82)",
    );
    near(rail.x, 1305, 2, "helper rail left");
    near(rail.y, 315, 2, "helper rail top");
    near(rail.width, 42, 1, "helper rail width");
    near(rail.y + rail.height, 569, 3, "helper rail bottom");
    near(arrow.x + arrow.width / 2, 1326, 2, "helper arrow center x");
    near(arrow.y, 395, 2, "helper arrow top");
    assert.deepEqual(
      captions.map(({ text }) => text),
      ["参", "数", "助", "手"],
    );
    for (const [index, caption] of captions.entries()) {
      near(caption.x + caption.width / 2, 1328, 2, "helper caption center x");
      near(
        caption.y + caption.height / 2,
        424 + 18 * index,
        2,
        "helper caption center y",
      );
      near(caption.height, 18, 0.5, "helper caption height");
    }
    return { rail, arrow, captions };
  };
  async function assertLegacyHelper() {
    assert.equal(await helperRailChevron.isVisible(), false);
    assert.notEqual(await railFill(), "rgb(243, 235, 216)");
  }
  const rawFormat = editor.getByRole("combobox", { name: "Raw格式" });
  const actions = editor.locator(".http-debug-raw-actions");
  const prefix = process.env.HTTP_DEBUG_RAW_CAPTURE_PREFIX;
  const measurements = {};
  async function capture(state) {
    if (!prefix) return;
    await page.mouse.move(800, 87);
    await page.evaluate(async () => {
      document.activeElement?.blur();
      await document.fonts.ready;
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await page.screenshot({
      path: `${prefix}-${state}.png`,
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  }
  assert.equal(await rawFormat.inputValue(), "json");
  assert.equal(await body.inputValue(), "");
  assert.equal(await gutter.textContent(), "1");
  assert(await generate.isVisible());
  assert.equal(await format.isVisible(), false);
  const toolbar = await actions.boundingBox();
  const code = await body.boundingBox();
  const leftGutter = await gutter.boundingBox();
  const expandBox = await expand.boundingBox();
  const helper = await editor.locator("#toggle-parameter-helper").boundingBox();
  const mode = await rawFormat.boundingBox();
  Object.assign(measurements, {
    toolbar,
    code,
    leftGutter,
    expandBox,
    helper,
    mode,
  });
  near(toolbar.x, 371, 1, "toolbar left");
  near(toolbar.y, 273, 2, "toolbar top");
  near(toolbar.height, 42, 1, "toolbar height");
  near(code.x, 433, 2, "editor text start");
  near(code.y, 315, 2, "editor top");
  near(leftGutter.width, 62, 1, "gutter span");
  near(helper.x, 1305, 3, "helper start");
  near(expandBox.x + expandBox.width / 2, 1280, 5, "expand center x");
  near(expandBox.y + expandBox.height / 2, 327, 4, "expand center y");
  near(mode.x, 864, 4, "Raw format control left");
  assert.deepEqual(
    await editor
      .locator("#body-code, #code-highlight, #code-gutter")
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).lineHeight),
      ),
    ["16px", "16px", "16px"],
  );
  measurements.closedHelperEmpty = await measureClosedHelper();
  await capture("empty");

  await body.focus();
  await page.keyboard.insertText(original);
  assert.equal(await body.inputValue(), original);
  assert(await format.isVisible());
  const polish = await format.boundingBox();
  measurements.format = polish;
  near(polish.x + polish.width / 2, 1230, 8, "beautify center");
  await capture("one-line");
  await format.press("Enter");
  assert.equal(await body.inputValue(), formatted);
  assert.equal(await detail(gutter), "1\n2\n3\n4\n5");
  assert(await format.evaluate((el) => el === document.activeElement));
  assert.deepEqual(await page.evaluate(() => window.__bodyCopyEvents), []);
  const ink = (surface, type) =>
    surface
      .locator(`#code-highlight .syntax-${type}`)
      .first()
      .evaluate((el) => getComputedStyle(el).color);
  for (const [type, color] of Object.entries(palette))
    assert.equal(await ink(editor, type), color);
  const indent = await editor
    .locator("#code-highlight")
    .evaluate((highlight) => {
      const key = highlight.querySelector(".syntax-key");
      const prefix = key.previousSibling;
      const start = prefix.textContent.lastIndexOf("\n") + 1;
      const space = document.createRange();
      space.setStart(prefix, start);
      space.setEnd(prefix, start + 1);
      const spaceBox = space.getBoundingClientRect();
      const style = getComputedStyle(highlight);
      return {
        whitespace: prefix.textContent.slice(start),
        charWidth: spaceBox.width,
        lineStartX: spaceBox.x,
        editorTextX:
          highlight.getBoundingClientRect().x + parseFloat(style.paddingLeft),
        keyX: key.getBoundingClientRect().x,
      };
    });
  assert.deepEqual(
    Array.from(indent.whitespace, (character) => character.charCodeAt(0)),
    [0x20, 0x20, 0x20, 0x20],
  );
  assert(indent.charWidth > 0, "rendered ASCII space must have a width");
  near(indent.lineStartX, indent.editorTextX, 1, "first text column");
  const offset = indent.keyX - indent.lineStartX;
  const columns = offset / indent.charWidth;
  near(columns, 4, 0.15, "native indentation in actual rendered columns");
  // Only paired PNG captures on the calibrated font can assert native pixels.
  const compareNativePNG =
    process.env.HTTP_DEBUG_RAW_COMPARE_NATIVE_PNG === "1";
  if (compareNativePNG) {
    assert(prefix, "native PNG comparison requires an output capture prefix");
    near(indent.charWidth, 7.25, 0.25, "reference font space calibration");
    near(offset, 29, 3, "calibrated native PNG indentation");
  }
  measurements.indent = { ...indent, offset, columns, compareNativePNG };
  measurements.closedHelperFormatted = await measureClosedHelper();
  await capture("formatted");

  await helperToggle.press("Enter");
  assert.equal(await helperToggle.getAttribute("aria-expanded"), "true");
  assert.equal(
    await helperToggle.getAttribute("aria-controls"),
    "body-parameter-helper",
  );
  assert(await helperPanel.isVisible());
  assert(
    await helperToggle.evaluate((button) => button === document.activeElement),
  );
  assert(
    await helperToggle.evaluate(
      (button) => getComputedStyle(button).outlineWidth === "2px",
    ),
  );
  const dictionaryTab = helperPanel.getByRole("tab", { name: "字典库" });
  const dynamicTab = helperPanel.getByRole("tab", { name: "动态值" });
  assert.equal(await dictionaryTab.getAttribute("aria-selected"), "true");
  assert(await helperPanel.getByRole("searchbox").isVisible());
  assert(await helperPanel.getByText("当前项目暂无字典参数").isVisible());
  const openBox = await helperPanel.boundingBox();
  near(openBox.x, 1051, 3, "open helper left");
  near(openBox.y, 315, 2, "open helper top");
  near(openBox.width, 296, 2, "open helper width");
  near(openBox.y + openBox.height, 570, 3, "open helper bottom");
  measurements.openHelper = openBox;
  await capture("open-empty");
  await dictionaryTab.press("ArrowRight");
  assert.equal(await dynamicTab.getAttribute("aria-selected"), "true");
  assert(await dynamicTab.evaluate((tab) => tab === document.activeElement));
  assert.equal(await helperPanel.getByRole("searchbox").count(), 0);
  for (const name of ["动态值", "内置动态变量", "共享函数", "请求结构"])
    assert.equal(
      await helperPanel.getByRole("heading", { name, exact: true }).count(),
      1,
    );
  assert(
    await helperPanel
      .getByRole("button", { name: "引用变量", exact: true })
      .isVisible(),
  );
  await capture("open-dynamic");
  await dynamicTab.press("ArrowLeft");
  assert.equal(await dictionaryTab.getAttribute("aria-selected"), "true");
  assert(await dictionaryTab.evaluate((tab) => tab === document.activeElement));
  assert(await helperPanel.getByRole("searchbox").isVisible());
  assert.equal(
    await helperPanel
      .getByRole("heading", { name: "动态值", exact: true })
      .count(),
    0,
  );
  assert.equal(await body.inputValue(), formatted);
  await helperToggle.press("Space");
  assert.equal(await helperToggle.getAttribute("aria-expanded"), "false");
  assert.equal(await helperPanel.count(), 0);
  assert(
    await helperToggle.evaluate((button) => button === document.activeElement),
  );
  assert(await helperRailChevron.isVisible());
  assert.equal(await body.inputValue(), formatted);

  await page.locator("#theme").click();
  assert(await page.locator("body.dark").count());
  await assertLegacyHelper();
  await page.locator("#theme").click();
  assert(await helperRailChevron.isVisible());

  await body.fill(invalid);
  await format.press("Space");
  assert.equal(await body.inputValue(), invalid);
  assert.equal(await rawFormat.inputValue(), "json");
  await body.fill(formatted);
  await body.selectText();
  await page.keyboard.press("ControlOrMeta+c");
  assert.deepEqual(await page.evaluate(() => window.__bodyCopyEvents), [
    formatted,
  ]);
  assert.equal(await body.inputValue(), formatted);

  await expand.press("Enter");
  assert.equal(await expand.getAttribute("aria-pressed"), "true");
  assert(await body.evaluate((el) => el === document.activeElement));
  await page.keyboard.press("Escape");
  assert.equal(await expand.getAttribute("aria-pressed"), "false");
  assert(await expand.evaluate((el) => el === document.activeElement));
  assert.equal(await body.inputValue(), formatted);

  await rawFormat.selectOption("raw");
  assert.equal(await actions.count(), 0);
  await body.fill(original);
  await format.press("Enter");
  assert.equal(await body.inputValue(), formattedTwoColumns);
  assert.equal(await ink(editor, "key"), "rgb(155, 89, 101)");
  const plain = 'not JSON — "local draft"';
  await body.fill(plain);
  assert.equal(await body.inputValue(), plain);
  await rawFormat.selectOption("json");
  assert.equal(await body.inputValue(), plain);
  await editor.locator('[data-mode="design"]').click();
  const design = page.locator('.editor[data-editor-mode="design"]');
  await design.locator('[data-design-parameter="body"]').click();
  const designBody = design.locator("#body-code");
  await designBody.fill(original);
  await design.locator("#format-json").press("Enter");
  assert.equal(await designBody.inputValue(), formattedTwoColumns);
  assert.equal(await ink(design, "key"), "rgb(155, 89, 101)");
  await design.locator('[data-mode="debug"]').click();
  await bodyTab.click();
  await body.fill(original);
  await page.locator("#response-layout").click();
  assert.equal(await ink(editor, "key"), "rgb(155, 89, 101)");
  await assertLegacyHelper();
  await page.locator("#response-layout").click();
  await page.setViewportSize({ width: 430, height: 760 });
  assert.equal(await ink(editor, "key"), "rgb(155, 89, 101)");
  await assertLegacyHelper();
  const compactToolbar = await actions.boundingBox();
  const surfaceWidth = await page.evaluate(
    () => document.documentElement.clientWidth,
  );
  for (const control of [generate, format, expand]) {
    const box = await control.boundingBox();
    assert(
      box && box.x >= compactToolbar.x && box.x + box.width <= surfaceWidth + 1,
      JSON.stringify(box),
    );
  }
  await format.press("Enter");
  assert.equal(await body.inputValue(), formatted);

  await page.setViewportSize({ width: 1363, height: 1023 });
  const projectSelector = page.locator("#project-select");
  const displayedOwner = projectSelector.locator("option[selected]");
  assert.equal(await displayedOwner.getAttribute("value"), project.id);
  await chooseProjectSwitch(page, "discard", async () => {
    await projectSelector.selectOption(dictionaryProject.id);
    assert.equal(await displayedOwner.getAttribute("value"), project.id);
  });
  await projectSwitchPrompt(page).waitFor({ state: "hidden" });
  assert.equal(
    await displayedOwner.getAttribute("value"),
    dictionaryProject.id,
  );
  await page.locator('[data-request="dictionary-draft"]').click();
  await bodyTab.click();
  await helperToggle.press("Enter");
  const filter = helperPanel.getByRole("searchbox", {
    name: "搜索参数、备注或描述",
  });
  const rows = helperPanel.locator(".raw-helper-entries button:visible");
  const tablist = helperPanel.getByRole("tablist");
  assert.equal(await rows.count(), 2);
  for (const [query, key] of [
    ["  REQUESTID ", "requestId"],
    ["only note", "requestId"],
    ["page size", "limit"],
  ]) {
    await filter.fill(query);
    assert.equal(await rows.count(), 1);
    assert.match(await rows.first().textContent(), new RegExp(key));
    assert.equal(await body.inputValue(), original);
  }
  await filter.fill("not present");
  assert(await helperPanel.getByText("没有匹配的字典参数").isVisible());
  assert.equal(await rows.count(), 0);
  await filter.fill("only note");
  await rows.first().press("Enter");
  const insertedBody = await body.inputValue();
  assert.deepEqual(JSON.parse(insertedBody), {
    ...JSON.parse(original),
    requestId: "draft-only",
  });
  assert.equal(await filter.inputValue(), "only note");
  await rows.first().press("Enter");
  assert.equal(await body.inputValue(), insertedBody);
  const flips = [
    () => page.locator("#theme").click(),
    () => page.locator("#response-layout").click(),
    async () =>
      page.setViewportSize(
        (await page.viewportSize()).width === 1363
          ? { width: 430, height: 760 }
          : { width: 1363, height: 1023 },
      ),
  ];
  for (const [index, flip] of flips.entries()) {
    const unchangedEditor = index === 1 ? await body.elementHandle() : null;
    await flip();
    await tablist.waitFor({ state: "detached" });
    assert(
      await helperPanel
        .getByRole("heading", {
          name: "参数字典 · 插入 JSON 字段",
          exact: true,
        })
        .isVisible(),
    );
    assert.equal(await body.inputValue(), insertedBody);
    if (unchangedEditor)
      assert(await unchangedEditor.evaluate((node) => node.isConnected));
    await flip();
    await tablist.waitFor();
    if (unchangedEditor)
      assert(await unchangedEditor.evaluate((node) => node.isConnected));
    assert.equal(await filter.inputValue(), "only note");
    assert.equal(await body.inputValue(), insertedBody);
  }
  await helperToggle.press("Space");
  await helperToggle.press("Enter");
  assert.equal(await filter.inputValue(), "");
  assert.equal(await rows.count(), 2);
  assert.equal(await body.inputValue(), insertedBody);

  await helperPanel.getByRole("tab", { name: "字典库" }).press("ArrowRight");
  const reference = helperPanel.getByRole("button", {
    name: "引用变量",
    exact: true,
  });
  const chooser = page.getByRole("dialog", { name: "引用变量" });
  const waitChooserClosed = async () => {
    await chooser.waitFor({ state: "hidden" });
    assert.equal(
      await page.locator("#dialog").evaluate((el) => el.open),
      false,
    );
  };
  const variableSearch = chooser.getByRole("searchbox", { name: "变量名" });
  const confirmSelection = chooser.getByRole("button", {
    name: "确定",
    exact: true,
  });
  const variableRows = chooser.locator(
    "button[data-raw-variable-name]:visible",
  );

  await reference.press("Enter");
  assert(await variableSearch.evaluate((el) => el === document.activeElement));
  assert(await confirmSelection.isDisabled());
  assert.match(await chooser.textContent(), /fixtureGlobalName/);
  assert.match(await chooser.textContent(), /fixtureEnvironmentName/);
  for (const name of ["collectionOnlyName", "collectionShadowsGlobal"]) {
    const row = chooser.locator(`[data-raw-variable-name="${name}"]`);
    assert.equal(await row.count(), 1);
    assert.match(await row.textContent(), /集合变量/);
  }
  assert.doesNotMatch(
    await chooser.textContent(),
    /synthetic-.*secret|unrelatedEnvironmentName|unrelatedCollectionName|definitionOnlyName|\$telephone/,
  );
  const duplicate = chooser.locator(
    '[data-raw-variable-name="duplicatedName"]',
  );
  assert.equal(await duplicate.count(), 1);
  assert.match(await duplicate.textContent(), /环境变量/);
  const chooserBox = await chooser.boundingBox();
  near(chooserBox.x, 696, 5, "variable chooser left");
  near(chooserBox.y, 210, 5, "variable chooser top");
  near(chooserBox.width, 360, 2, "variable chooser width");
  near(chooserBox.height, 536, 3, "variable chooser height");
  measurements.variableChooser = chooserBox;
  // Capture the settled shell with synthetic names only.
  await capture("open-variable");
  await variableSearch.fill("unavailable variable");
  assert.equal(await variableRows.count(), 0);
  assert(await chooser.getByText("没有匹配的变量").isVisible());
  await variableSearch.press("Enter");
  assert(await chooser.isVisible());
  assert(await confirmSelection.isDisabled());
  await page.keyboard.press("Escape");
  await waitChooserClosed();
  assert(await reference.evaluate((el) => el === document.activeElement));
  assert.equal(await body.inputValue(), insertedBody);

  await reference.press("Enter");
  await chooser.getByRole("button", { name: "取消", exact: true }).click();
  await waitChooserClosed();
  assert(await reference.evaluate((el) => el === document.activeElement));
  assert.equal(await body.inputValue(), insertedBody);

  await reference.press("Enter");
  await variableSearch.fill("fixtureEnvironmentName");
  await variableSearch.press("ArrowDown");
  await page.keyboard.press("Space");
  await page.setViewportSize({ width: 430, height: 760 });
  await confirmSelection.click();
  assert(await chooser.isVisible());
  assert.match(
    await page.locator("#toast").textContent(),
    /接口、环境或草稿已变化/,
  );
  await page.keyboard.press("Escape");
  await waitChooserClosed();
  await page.setViewportSize({ width: 1363, height: 1023 });
  await reference.waitFor();
  assert.equal(await body.inputValue(), insertedBody);

  const start = insertedBody.indexOf("local synthetic draft");
  await body.evaluate(
    (el, start) =>
      el.setSelectionRange(start, start + "local synthetic draft".length),
    start,
  );
  await reference.press("Enter");
  await variableSearch.fill("fixtureENVIRONMENT");
  assert.equal(await variableRows.count(), 1);
  await variableSearch.press("ArrowDown");
  assert(
    await variableRows.first().evaluate((el) => el === document.activeElement),
  );
  await page.keyboard.press("Space");
  assert.equal(await variableRows.first().getAttribute("aria-pressed"), "true");
  assert(await confirmSelection.isEnabled());
  await confirmSelection.press("Enter");
  await waitChooserClosed();
  assert.equal(
    await body.inputValue(),
    insertedBody.replace("local synthetic draft", "{{fixtureEnvironmentName}}"),
  );
  assert(await body.evaluate((el) => el === document.activeElement));

  const fixedCard = helperPanel.getByRole("button", {
    name: "固定值",
    exact: true,
  });
  const fixedDialog = page.getByRole("dialog", { name: "固定值", exact: true });
  const fixedValue = fixedDialog.getByRole("textbox", {
    name: "固定值",
    exact: true,
  });
  const fixedExpression = fixedDialog.getByRole("textbox", {
    name: "表达式",
    exact: true,
  });
  const fixedPreview = fixedDialog.getByRole("textbox", {
    name: "预览",
    exact: true,
  });
  const fixedConfirm = fixedDialog.getByRole("button", {
    name: "确定",
    exact: true,
  });
  const waitFixedClosed = async () => {
    await fixedDialog.waitFor({ state: "hidden" });
    assert.equal(
      await page.locator("#dialog").evaluate((el) => el.open),
      false,
    );
  };
  const fixedText = "local synthetic fixed";
  await body.fill("");
  await fixedCard.press("Enter");
  assert(await fixedValue.evaluate((el) => el === document.activeElement));
  assert(await fixedConfirm.isDisabled());
  assert.equal(await fixedExpression.inputValue(), "");
  assert.equal(await fixedPreview.inputValue(), "");
  const fixedBox = await fixedDialog.boundingBox();
  near(fixedBox.x, 696, 5, "fixed dialog left");
  near(fixedBox.y, 210, 5, "fixed dialog top");
  near(fixedBox.width, 360, 2, "fixed dialog width");
  near(fixedBox.height, 536, 3, "fixed dialog height");
  measurements.fixedChooser = fixedBox;
  await capture("open-fixed");
  await fixedValue.fill(fixedText);
  assert.match(
    await fixedExpression.inputValue(),
    /^\{\{@value:[a-z0-9-]+\}\}$/,
  );
  assert.equal(await fixedPreview.inputValue(), JSON.stringify(fixedText));
  assert(await fixedExpression.evaluate((el) => el.readOnly));
  assert(await fixedPreview.evaluate((el) => el.readOnly));
  assert(await fixedConfirm.isEnabled());
  assert.equal(await body.inputValue(), "");
  await fixedValue.press("Enter");
  assert(await fixedDialog.isVisible());
  await fixedValue.press("Escape");
  await waitFixedClosed();
  assert(await fixedCard.evaluate((el) => el === document.activeElement));
  assert.equal(await body.inputValue(), "");

  await fixedCard.press("Enter");
  await fixedValue.fill(fixedText);
  await fixedDialog.getByRole("button", { name: "取消", exact: true }).click();
  await waitFixedClosed();
  assert(await fixedCard.evaluate((el) => el === document.activeElement));
  assert.equal(await body.inputValue(), "");

  await fixedCard.press("Enter");
  await fixedValue.fill(fixedText);
  await page.setViewportSize({ width: 430, height: 760 });
  await fixedConfirm.click();
  assert(await fixedDialog.isVisible());
  assert.match(
    await page.locator("#toast").textContent(),
    /接口、环境或草稿已变化/,
  );
  await page.keyboard.press("Escape");
  await waitFixedClosed();
  await page.setViewportSize({ width: 1363, height: 1023 });
  await fixedCard.waitFor();
  assert.equal(await body.inputValue(), "");

  await fixedCard.press("Enter");
  await fixedValue.fill(fixedText);
  const fixedToken = await fixedExpression.inputValue();
  await capture("open-fixed-filled");
  await fixedConfirm.press("Enter");
  await waitFixedClosed();
  assert.equal(await body.inputValue(), fixedToken);
  assert(await body.evaluate((el) => el === document.activeElement));
  assert.equal(
    await body.evaluate((el) => el.selectionStart),
    fixedToken.length,
  );
  await capture("fixed-inserted");
  const dynamicId = fixedToken.slice("{{@value:".length, -2);
  await helperPanel
    .locator(`[data-edit-body-dynamic="${dynamicId}"]`)
    .press("Enter");
  const legacyDynamic = page.getByRole("dialog", { name: "动态参数值" });
  assert.equal(
    await legacyDynamic.locator("#dynamic-source").inputValue(),
    "fixed",
  );
  assert.equal(
    await legacyDynamic.locator("#dynamic-value").inputValue(),
    JSON.stringify(fixedText),
  );
  assert.equal(
    await legacyDynamic.locator("#dynamic-format").inputValue(),
    "json",
  );
  assert.equal(
    await legacyDynamic.locator("#dynamic-functions").inputValue(),
    "",
  );
  await legacyDynamic
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await legacyDynamic.waitFor({ state: "hidden" });
  assert.equal(await body.inputValue(), fixedToken);

  for (const [requestId, absentNames, winner, scope] of [
    [
      "unbound-helper-draft",
      /collectionOnlyName|unrelatedCollectionName/,
      "collectionShadowsGlobal",
      "全局变量",
    ],
    [
      "other-helper-draft",
      /collectionOnlyName/,
      "unrelatedCollectionName",
      "集合变量",
    ],
  ]) {
    await page.locator(`[data-request="${requestId}"]`).click();
    await bodyTab.click();
    if ((await helperToggle.getAttribute("aria-expanded")) === "false")
      await helperToggle.press("Enter");
    await helperPanel.getByRole("tab", { name: "动态值" }).click();
    await reference.press("Enter");
    assert.doesNotMatch(await chooser.textContent(), absentNames);
    assert.match(
      await chooser
        .locator(`[data-raw-variable-name="${winner}"]`)
        .textContent(),
      new RegExp(scope),
    );
    assert.doesNotMatch(await chooser.textContent(), /synthetic-.*secret/);
    await page.keyboard.press("Escape");
    await waitChooserClosed();
  }

  const mockCard = helperPanel.getByRole("button", {
    name: "Mock数据",
    exact: true,
  });
  const mockDialog = page.getByRole("dialog", {
    name: "Mock数据",
    exact: true,
  });
  const mockSearch = mockDialog.getByRole("searchbox", { name: "Mock 规则" });
  const mockConfirm = mockDialog.getByRole("button", {
    name: "确定",
    exact: true,
  });
  const mockExpression = mockDialog.getByRole("textbox", {
    name: "表达式",
    exact: true,
  });
  const mockDateRule = mockDialog.locator('[data-raw-mock-rule="date"]');
  const waitMockClosed = async () => {
    await mockDialog.waitFor({ state: "hidden" });
    assert.equal(
      await page.locator("#dialog").evaluate((el) => el.open),
      false,
    );
  };
  await mockCard.press("Enter");
  assert(await mockSearch.evaluate((el) => el === document.activeElement));
  assert(await mockConfirm.isDisabled());
  assert.equal(await mockExpression.inputValue(), "");
  assert.equal(await mockDateRule.isVisible(), false);
  const mockBox = await mockDialog.boundingBox();
  near(mockBox.x, 696, 5, "Mock chooser left");
  near(mockBox.y, 210, 5, "Mock chooser top");
  near(mockBox.width, 360, 2, "Mock chooser width");
  near(mockBox.height, 536, 3, "Mock chooser height");
  measurements.mockChooser = mockBox;
  await capture("open-mock");
  await mockDialog
    .locator('[data-raw-mock-group="日期"] > summary')
    .press("Enter");
  assert(await mockDateRule.isVisible());
  assert.match(await mockDateRule.textContent(), /@date\(\)/);
  assert(await mockConfirm.isDisabled());
  await capture("open-mock-expanded");
  await mockSearch.fill("@now()");
  assert.equal(
    await mockDialog.locator("[data-raw-mock-rule]:visible").count(),
    0,
  );
  assert(await mockDialog.getByText("没有匹配的内置规则").isVisible());
  await mockSearch.press("Enter");
  assert(await mockDialog.isVisible());
  await mockSearch.press("Escape");
  await waitMockClosed();
  assert(await mockCard.evaluate((el) => el === document.activeElement));
  assert.equal(await body.inputValue(), "");

  await mockCard.press("Enter");
  await mockSearch.fill("@date()");
  assert.equal(
    await mockDialog.locator("[data-raw-mock-rule]:visible").count(),
    1,
  );
  await mockSearch.press("ArrowDown");
  assert(await mockDateRule.evaluate((el) => el === document.activeElement));
  await page.keyboard.press("Space");
  assert(await mockConfirm.isEnabled());
  await page.setViewportSize({ width: 430, height: 760 });
  await mockConfirm.click();
  assert(await mockDialog.isVisible());
  assert.match(
    await page.locator("#toast").textContent(),
    /接口、环境或草稿已变化/,
  );
  await mockDialog.getByRole("button", { name: "取消", exact: true }).click();
  await waitMockClosed();
  await page.setViewportSize({ width: 1363, height: 1023 });
  await mockCard.waitFor();
  assert.equal(await body.inputValue(), "");

  await mockCard.press("Enter");
  await mockSearch.fill("@date()");
  await mockDateRule.press("Enter");
  const mockToken = await mockExpression.inputValue();
  assert.match(mockToken, /^\{\{@value:[a-z0-9-]+\}\}$/);
  assert(await mockExpression.evaluate((el) => el.readOnly));
  assert.equal(await mockDialog.getByText("预览", { exact: true }).count(), 0);
  assert.equal(await body.inputValue(), "");
  await mockConfirm.press("Enter");
  await waitMockClosed();
  assert.equal(await body.inputValue(), mockToken);
  assert(await body.evaluate((el) => el === document.activeElement));
  const mockId = mockToken.slice("{{@value:".length, -2);
  await helperPanel
    .locator(`[data-edit-body-dynamic="${mockId}"]`)
    .press("Enter");
  const oldEditor = page.getByRole("dialog", { name: "动态参数值" });
  assert.equal(await oldEditor.locator("#dynamic-source").inputValue(), "mock");
  assert.equal(
    await oldEditor.locator("#dynamic-value").inputValue(),
    "@date()",
  );
  assert.equal(await oldEditor.locator("#dynamic-format").inputValue(), "json");
  assert.equal(
    await oldEditor.locator("#dynamic-mock-type").inputValue(),
    "string",
  );
  assert.equal(await oldEditor.locator("#dynamic-functions").inputValue(), "");
  await oldEditor.getByRole("button", { name: "取消", exact: true }).click();
  await oldEditor.waitFor({ state: "hidden" });
  assert.equal(await body.inputValue(), mockToken);
  for (const flip of [
    () => page.locator("#theme").click(),
    () => page.locator("#response-layout").click(),
    () =>
      page.setViewportSize(
        page.viewportSize().width === 1363
          ? { width: 430, height: 760 }
          : { width: 1363, height: 1023 },
      ),
  ]) {
    await flip();
    await mockCard.waitFor({ state: "hidden" });
    assert(await helperPanel.locator("#new-body-dynamic").isVisible());
    assert.equal(await body.inputValue(), mockToken);
    await flip();
    await mockCard.waitFor();
  }

  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(await app.store.get(project.id), baseline);
  assert.deepEqual(
    await app.store.get(dictionaryProject.id),
    dictionaryBaseline,
  );
  if (prefix)
    await writeFile(
      prefix + ".json",
      JSON.stringify(measurements, null, 2) + "\n",
    );
  console.log(
    "HTTP_DEBUG_BODY_RAW_UI_PASS geometry/beautify/invalid/copy/expand/helper/narrow/no-dispatch",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

async function detail(gutter) {
  return (await gutter.textContent()).trim();
}
