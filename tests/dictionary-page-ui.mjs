import { pickProjectUI } from "./helpers/pick-project-ui.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { builtinParameters } from "../public/dictionary-view.js";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.DICTIONARY_PAGE_EVIDENCE;
const root = await mkdtemp("/tmp/workbench-dictionary-page-");
const app = await createApp({ root, port: 0 });
const project = await app.store.create("默认项目");
const populated = await app.store.create("Synthetic dictionary");
const projectData = [
  {
    id: "fixture-verification",
    key: "workbenchExample",
    type: "string",
    description: "合成搜索描述",
    note: "保留的本地备注",
    example: "neutral",
  },
  {
    id: "fixture-count",
    key: "workbenchCount",
    type: "integer",
    description: "另一条记录",
    default: 7,
  },
];
project.settings.builtinDictionary = true;
await app.store.save(project);
populated.parameterDictionary = projectData;
populated.dictionary = [
  { id: "model-fixture", name: "Fixture Model", schema: {} },
];
await app.store.save(populated);
let browser;
try {
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
    writes = [];
  let allowToggleSave = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    if (
      allowToggleSave &&
      url.origin === origin &&
      url.pathname === "/api/projects/" + project.id &&
      request.method() === "PUT"
    ) {
      allowToggleSave = false;
      writes.push(request.postDataJSON().settings.builtinDictionary);
      return route.continue();
    }
    blocked.push(request.method() + " " + url.pathname);
    return route.abort();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = (state) =>
    evidence &&
    page.screenshot({
      path: join(evidence, "dictionary-workbench-" + state + ".png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  const enter = () =>
    page.locator('.rail [data-page="dictionary"]').press("Enter");
  const area = page.getByRole("region", { name: "数据字典", exact: true });
  const custom = area.getByRole("tab", { name: "自定义", exact: true });
  const builtin = area.getByRole("tab", { name: "系统内置", exact: true });
  const customPanel = area.getByRole("tabpanel", {
    name: "自定义",
    exact: true,
  });
  const builtinPanel = area.getByRole("tabpanel", {
    name: "系统内置",
    exact: true,
  });
  const customSearch = customPanel.getByRole("searchbox");
  const builtinSearch = builtinPanel.getByRole("searchbox");
  const focusIs = (locator) =>
    locator.evaluate(
      (element) => element.ownerDocument.activeElement === element,
    );

  await page.goto(app.launchUrl);
  await pickProjectUI(page, project.id);
  await enter();
  await customPanel
    .getByRole("status")
    .getByText("暂无数据", { exact: true })
    .waitFor();
  assert.equal(await custom.getAttribute("aria-selected"), "true");
  assert(await builtinPanel.isHidden());
  const metrics = await area.evaluate((surface) => {
    const rect = (selector) => {
      const { x, y, width, height } = surface
        .querySelector(selector)
        .getBoundingClientRect();
      return [x, y, width, height].map(Math.round);
    };
    return {
      header: rect(".dictionary-title-strip"),
      tabs: rect(".dictionary-tabs"),
      search: rect(".dictionary-search"),
    };
  });
  assert.deepEqual(metrics.header.slice(0, 2), [364, 44]);
  assert.equal(metrics.header[3], 38);
  assert.deepEqual(metrics.tabs.slice(0, 2), [384, 82]);
  assert.equal(metrics.tabs[3], 55);
  assert.deepEqual(metrics.search, [384, 149, 220, 32]);
  await page.mouse.move(1080, 480);
  await capture("custom-empty");

  await custom.press("ArrowRight");
  assert(await focusIs(builtin));
  assert.equal(await builtin.getAttribute("aria-selected"), "true");
  assert(await customPanel.isHidden());
  await page.keyboard.press("Tab");
  assert(await focusIs(builtinSearch));
  const systemTable = builtinPanel.getByRole("table", { name: "系统内置参数" });
  assert.deepEqual(
    await systemTable
      .locator("tbody .dictionary-name-line [data-dictionary-match]")
      .allTextContents(),
    builtinParameters.map((entry) => entry.key),
  );
  const shell = await systemTable.boundingBox();
  const row = await systemTable.locator("tbody tr").first().boundingBox();
  assert.deepEqual(
    [Math.round(shell.x), Math.round(shell.y), Math.round(row.height)],
    [385, 197, 42],
  );
  const toggle = builtinPanel.getByRole("checkbox", {
    name: "启用内置常用参数",
  });
  assert(await toggle.isChecked());
  const readToggleStyle = () =>
    toggle.evaluate((element) => {
      const style = getComputedStyle(element);
      const { width, height } = element.getBoundingClientRect();
      return {
        width,
        height,
        appearance: style.appearance,
        track: style.backgroundColor,
        thumb: style.getPropertyValue("--dictionary-thumb-x").trim(),
        focus: [style.outlineStyle, style.outlineWidth],
      };
    });
  await builtinSearch.blur();
  await capture("builtins");
  const { width, height, appearance, track, thumb } = await readToggleStyle();
  assert.deepEqual(
    [width, height, appearance, track, thumb],
    [28, 16, "none", "rgb(137, 107, 58)", "20px"],
  );
  await builtinSearch.fill("电子邮");
  await systemTable.getByText("email", { exact: true }).waitFor();
  assert.equal(await systemTable.getByRole("row").count(), 2);
  await builtinSearch.fill("no-match");
  await builtinPanel.getByRole("status").getByText("未找到匹配参数").waitFor();
  assert(await systemTable.isHidden());
  await builtin.press("Home");
  assert(await focusIs(custom));
  assert.equal(await customSearch.inputValue(), "");
  await custom.press("End");
  assert.equal(await builtinSearch.inputValue(), "no-match");

  await pickProjectUI(page, populated.id);
  await enter();
  await customPanel.getByText("workbenchExample", { exact: true }).waitFor();
  assert.equal(await custom.getAttribute("aria-selected"), "true");
  await customSearch.fill("WORKBENCHCOUNT");
  await customPanel.getByText("workbenchCount", { exact: true }).waitFor();
  assert(
    await customPanel.getByText("workbenchExample", { exact: true }).isHidden(),
  );
  await customSearch.fill("合成搜索描述");
  const result = customPanel
    .getByRole("row")
    .filter({ hasText: "workbenchExample" });
  await result.getByText("保留的本地备注", { exact: true }).waitFor();
  assert(await result.getByText('"neutral"', { exact: true }).isVisible());
  await result
    .getByRole("button", { name: "编辑", exact: true })
    .press("Enter");
  assert.equal(
    await page.locator("#dict-key").inputValue(),
    "workbenchExample",
  );
  await page.keyboard.press("Escape");
  assert.equal(await customSearch.inputValue(), "合成搜索描述");
  await customSearch.clear();
  await capture("custom-stored-fixture");

  const modelsNav = page.getByRole("navigation", { name: "字典导航" });
  await modelsNav.getByRole("button", { name: "数据模型" }).press("Enter");
  const models = page.getByRole("region", { name: "数据模型" });
  assert(await focusIs(models.getByRole("heading", { name: "数据模型" })));
  await models.getByText("Fixture Model", { exact: true }).waitFor();
  await modelsNav.getByRole("button", { name: "数据字典" }).press("Enter");
  assert(await focusIs(area.getByRole("heading", { name: "数据字典" })));
  await page.setViewportSize({ width: 430, height: 760 });
  assert(await modelsNav.isHidden());
  assert(await area.getByRole("button", { name: "数据模型" }).isVisible());
  await custom.press("ArrowRight");
  await page.keyboard.press("Tab");
  assert(await focusIs(builtinSearch));
  assert.equal(await builtinSearch.inputValue(), "");
  await builtinSearch.fill("EMAIL");
  assert.equal(await systemTable.getByRole("row").count(), 2);
  assert.deepEqual(
    await page.evaluate(() => {
      const { clientWidth, scrollWidth } = document.documentElement;
      return [window.innerWidth, scrollWidth - clientWidth];
    }),
    [430, 0],
  );
  assert.equal(
    (await app.store.get(project.id)).settings.builtinDictionary,
    true,
  );
  const persisted = await app.store.get(populated.id);
  assert.deepEqual(
    persisted.parameterDictionary,
    populated.parameterDictionary,
  );
  assert.deepEqual(persisted.dictionary, populated.dictionary);
  // Only the original configured checkbox is styled. Keep the form control's
  // own focus, native state and draft-only change in the original project.
  await page.setViewportSize({ width: 1363, height: 1023 });
  await pickProjectUI(page, project.id);
  await enter();
  await page.waitForFunction(
    (id) =>
      document.querySelector(".dictionary-page")?.dataset.dictionaryProject ===
      id,
    project.id,
  );
  await custom.press("ArrowRight");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  assert(await focusIs(toggle));
  assert.deepEqual((await readToggleStyle()).focus, ["solid", "2px"]);
  await page.keyboard.press("Space");
  assert(!(await toggle.isChecked()));
  const off = await readToggleStyle();
  assert.deepEqual(
    [off.width, off.height, off.track, off.thumb],
    [28, 16, "rgb(131, 121, 101)", "8px"],
  );
  assert.deepEqual(writes, []);
  assert.equal(
    (await app.store.get(project.id)).settings.builtinDictionary,
    true,
  );
  await toggle.blur();
  await capture("builtins-off-workbench-only");
  await builtinPanel
    .locator("label.dictionary-builtin-option")
    .getByText("启用内置常用参数")
    .click();
  assert(await toggle.isChecked());

  // Forced-color and dark mode retain original platform checkbox painting.
  await page.emulateMedia({ forcedColors: "active" });
  assert.equal((await readToggleStyle()).appearance, "auto");
  await page.emulateMedia({ forcedColors: "none" });
  await page.getByRole("button", { name: "切换主题" }).click();
  assert.equal((await readToggleStyle()).appearance, "auto");
  await page.getByRole("button", { name: "切换主题" }).click();
  await page.setViewportSize({ width: 430, height: 760 });
  await toggle.press("Space");
  assert(!(await toggle.isChecked()));
  assert.equal((await readToggleStyle()).width, 28);
  assert.deepEqual(writes, []);
  assert.deepEqual(blocked, []);
  assert.equal(
    (await app.store.get(project.id)).settings.builtinDictionary,
    true,
  );
  allowToggleSave = true;
  await page.locator("#save-project").press("Enter");
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
  assert.deepEqual(writes, [false]);
  await page.setViewportSize({ width: 1363, height: 1023 });
  await page.reload();
  await enter();
  await custom.press("ArrowRight");
  assert(!(await toggle.isChecked()));
  assert.equal(
    (await app.store.get(project.id)).settings.builtinDictionary,
    false,
  );
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "DICTIONARY_PAGE_PASS stored/empty/builtin/search/keyboard/narrow/toggle-explicit-save",
    metrics,
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
