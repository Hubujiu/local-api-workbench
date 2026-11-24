import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const root = await mkdtemp("/tmp/workbench-workspace-globals-");
const app = await createApp({ root, port: 0 });
const captures = process.env.WORKSPACE_GLOBAL_VARIABLES_SCREENSHOTS;
const initialValues = { mode: "preview", threshold: 2 };
const initialDefinitions = {
  threshold: { initialValue: 0, description: "Neutral count" },
  queued: { initialValue: "waiting", description: "No current value" },
};
let browser;
try {
  const project = await app.store.create("全局变量工作台验证");
  const request = normalizeRequest({
    id: "workspace-global-fixture",
    name: "Verification",
    method: "GET",
    url: "http://127.0.0.1:38982/verification",
  });
  project.requests.push(request);
  project.environments[0].variables = {};
  if (!captures) {
    project.globalVariables = initialValues;
    project.globalVariableDefinitions = initialDefinitions;
  }
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
  const ownProject = "/api/projects/" + project.id;
  const forbidden = [],
    errors = [],
    snapshots = [];
  let allowSave = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    if (
      !captures &&
      allowSave &&
      url.origin === origin &&
      request.method() === "PUT" &&
      url.pathname === ownProject
    ) {
      allowSave = false;
      snapshots.push(request.postDataJSON());
      return route.continue();
    }
    forbidden.push(request.method() + " " + url.pathname);
    await route.abort();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.goto(app.launchUrl);
  await page.locator('[data-param="auth"]').click();
  const launcher = page.getByRole("button", { name: "环境设置", exact: true });
  const dialog = page.locator("#dialog");
  const navigation = dialog.getByLabel("环境设置导航");
  const globals = navigation.getByRole("button", {
    name: "全局变量",
    exact: true,
  });
  const cookie = navigation.getByRole("button", {
    name: "Cookie管理器",
    exact: true,
  });
  const defaultEnv = navigation.getByRole("button", {
    name: "默认环境",
    exact: true,
  });
  const title = dialog.locator("#dialog-title");
  const search = dialog.getByRole("searchbox", { name: "搜索全局变量" });
  const rows = dialog.locator("tr[data-global-row]");
  const stay = dialog.getByRole("button", { name: "保存", exact: true });
  const saveClose = dialog.getByRole("button", {
    name: "保存并关闭",
    exact: true,
  });
  const add = dialog.getByRole("button", { name: "＋ 添加变量" });
  const current = (row) => row.getByLabel("当前值 JSON", { exact: true });
  const field = (row, name) => row.getByLabel(name, { exact: true });
  const focusIs = (locator) =>
    locator.evaluate((el) => el === document.activeElement);
  const openGlobals = async () => {
    await launcher.press("Enter");
    await cookie.waitFor();
    await globals.press("Enter");
    assert.equal(await title.innerText(), "全局变量");
    assert.equal(await globals.getAttribute("aria-current"), "page");
    assert(await focusIs(search));
  };
  const close = async () => {
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => document.activeElement?.id === "open-environment-settings",
    );
  };
  const addRow = async (name, value, description) => {
    await add.press("Enter");
    const row = rows.last();
    assert(await focusIs(field(row, "变量名")));
    await field(row, "变量名").fill(name);
    await current(row).fill(value);
    await field(row, "变量描述").fill(description);
    return row;
  };
  await openGlobals();
  const modal = await dialog.boundingBox();
  const nav = await navigation.boundingBox();
  assert.equal(modal.width, 955);
  assert.equal(modal.height, 600);
  assert.equal(nav.width, 272);

  if (captures) {
    const capture = async (name) =>
      page.screenshot({
        path: join(captures, "env-workbench-globals-" + name + ".png"),
        clip: { x: 0, y: 0, width: 1363, height: 980 },
        caret: "hide",
        animations: "disabled",
      });
    await dialog.getByText("暂无全局变量", { exact: true }).waitFor();
    await search.blur();
    await capture("empty");
    await addRow("mode", '"preview"', "示例显示模式");
    await addRow("limit", "7", "示例条数上限");
    await rows
      .nth(0)
      .getByRole("button", { name: "显示值", exact: true })
      .click();
    await rows
      .nth(1)
      .getByRole("button", { name: "显示值", exact: true })
      .click();
    await capture("populated-draft");
    await close();
    const saved = await app.store.get(project.id);
    assert.deepEqual(saved.globalVariables || {}, {});
  } else {
    await page.setViewportSize({ width: 430, height: 770 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      430,
    );
    await stay.press("Enter"); // Opening and saving with no changes must not materialize defaults.
    assert.equal(await rows.count(), 3);
    assert.equal(await current(rows.first()).getAttribute("type"), "password");
    await rows
      .first()
      .getByRole("button", { name: "显示值", exact: true })
      .press("Enter");
    assert.equal(await current(rows.first()).getAttribute("type"), "text");
    await search.fill("Neutral count");
    assert.equal(await rows.count(), 1);
    assert.equal(await field(rows.first(), "变量名").inputValue(), "threshold");
    assert.equal(await current(rows.first()).getAttribute("type"), "password");
    await current(rows.first()).fill("{");
    await stay.press("Enter");
    await page.getByText(/第\d+行当前值不是有效JSON/).waitFor();
    assert.equal(await title.innerText(), "全局变量");
    assert.equal(await current(rows.first()).inputValue(), "{");
    let confirmCount = 0;
    const dismiss = (event) => {
      confirmCount++;
      return event.dismiss();
    };
    page.on("dialog", dismiss);
    await defaultEnv.press("Enter");
    page.off("dialog", dismiss);
    assert.equal(confirmCount, 1);
    assert.equal(await current(rows.first()).inputValue(), "{");
    const accept = (event) => event.accept();
    page.on("dialog", accept);
    await defaultEnv.press("Enter");
    page.off("dialog", accept);
    assert.equal(await title.innerText(), "环境设置");
    await globals.press("Enter");
    await search.fill("Neutral count");
    assert.equal(await current(rows.first()).inputValue(), "2");
    const details = rows.first().getByRole("button", { name: "初始值 / 操作" });
    await details.press("Enter");
    const initial = dialog.getByLabel("初始值 JSON");
    assert.equal(await initial.getAttribute("type"), "password");
    assert.equal(await initial.inputValue(), "0");
    await dialog.getByRole("checkbox", { name: "设置当前值" }).uncheck();
    assert(await current(rows.first()).isDisabled());
    await dialog.getByRole("button", { name: "恢复初始值" }).press("Enter");
    assert.equal(await current(rows.first()).inputValue(), "0");
    await current(rows.first()).fill("7");
    await search.fill("mode");
    await current(rows.first()).fill('"review"');
    await stay.press("Enter");
    assert.equal(await search.inputValue(), "mode");
    assert.equal(await current(rows.first()).inputValue(), '"review"');
    assert.deepEqual(snapshots, []);
    const beforeSave = await app.store.get(project.id);
    assert.deepEqual(beforeSave.globalVariables, initialValues);
    assert.deepEqual(beforeSave.globalVariableDefinitions, initialDefinitions);
    await addRow("enabled", "false", "Synthetic boolean");
    await saveClose.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => document.activeElement?.id === "open-environment-settings",
    );
    assert.deepEqual(snapshots, []);
    allowSave = true;
    await page.locator("#save-project").click();
    await page
      .locator("#saved-state")
      .getByText("✓ 已保存", { exact: true })
      .waitFor();
    assert.equal(snapshots.length, 1);
    const wantedVariables = { mode: "review", threshold: 7, enabled: false };
    const wantedDefinitions = {
      ...initialDefinitions,
      enabled: { initialValue: "", description: "Synthetic boolean" },
    };
    assert.deepEqual(snapshots[0].globalVariables, wantedVariables);
    assert.deepEqual(snapshots[0].globalVariableDefinitions, wantedDefinitions);
    assert.deepEqual(snapshots[0].environments[0].variables, {});
    await page.reload();
    await openGlobals();
    await search.fill("Neutral count");
    assert.equal(await current(rows.first()).inputValue(), "7");
    await search.fill("No current value");
    assert(await current(rows.first()).isDisabled());
    await close();
    assert.equal(await page.locator("#url").inputValue(), request.url);
    const reloaded = await app.store.get(project.id);
    assert.deepEqual(reloaded.globalVariables, wantedVariables);
    assert.deepEqual(reloaded.globalVariableDefinitions, wantedDefinitions);

    await page.setViewportSize({ width: 1363, height: 1023 });
    await page.locator('.rail [data-page="settings"]').click();
    await page
      .locator('[data-settings-anchor="settings-environments"]')
      .click();
    await page.locator("#edit-global-definitions").click();
    assert.equal(await title.innerText(), "全局变量 · 初始值 / 当前值");
    assert.equal(await navigation.count(), 0);
  }
  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ modal, nav, writes: snapshots.length, errors, forbidden }),
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
