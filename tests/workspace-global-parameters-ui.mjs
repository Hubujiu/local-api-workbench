import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const root = await mkdtemp("/tmp/workbench-global-parameters-");
const app = await createApp({ root, port: 0 });
const captures = process.env.WORKSPACE_GLOBAL_PARAMETER_SCREENSHOTS;
const globalParameters = {
  headers: [
    { key: "X-First", value: "synthetic" },
    { key: "X-Paused", value: "neutral", enabled: false },
  ],
  query: [{ key: "line", value: "A\r\nB" }],
  cookies: [{ key: "view", value: "compact", enabled: false }],
  form: [{ key: "mode", value: "preview", enabled: true }],
};
const independent = {
  recursiveFolderScopes: false,
  folderParameters: {
    Sample: { headers: [{ key: "X-First", value: "child", enabled: false }] },
  },
  parameterDescriptions: [
    {
      key: "X-First",
      description: "Unrelated description",
      apipostSource: { projectId: "example", id: "native-item" },
    },
  ],
};
let browser;
try {
  const project = await app.store.create("项目公共参数验证");
  const request = normalizeRequest({
    id: "workspace-parameter-fixture",
    name: "Verification",
    url: "http://127.0.0.1:38982/verification",
    inheritGlobalParameters: false,
  });
  project.requests.push(request);
  if (!captures)
    Object.assign(project.settings, independent, { globalParameters });
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
  const own = "/api/projects/" + project.id;
  const snapshots = [],
    errors = [],
    forbidden = [];
  let permitSave = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin === origin && req.method() === "GET")
      return route.continue();
    if (
      !captures &&
      permitSave &&
      url.origin === origin &&
      url.pathname === own &&
      req.method() === "PUT"
    ) {
      permitSave = false;
      snapshots.push(req.postDataJSON());
      return route.continue();
    }
    forbidden.push(req.method() + " " + url.pathname);
    return route.abort();
  });
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  await page.goto(app.launchUrl);
  await page.locator('[data-param="auth"]').click();
  const launcher = page.getByRole("button", { name: "环境设置", exact: true });
  const dialog = page.locator("#dialog");
  const title = dialog.locator("#dialog-title");
  const navigation = dialog.getByLabel("环境设置导航");
  const params = navigation.getByRole("button", {
    name: "全局参数",
    exact: true,
  });
  const globalVars = navigation.getByRole("button", {
    name: "全局变量",
    exact: true,
  });
  const tab = (name) => dialog.getByRole("tab", { name, exact: true });
  const enabled = (row) =>
    row.getByRole("checkbox", { name: "启用参数", exact: true });
  const rowName = (row) =>
    row.getByRole("textbox", { name: "参数名", exact: true });
  const rows = dialog.locator("[data-workspace-parameter-row]");
  const value = dialog.getByRole("textbox", { name: /参数值（JSON 字符串/ });
  const stay = dialog.getByRole("button", { name: "保存", exact: true });
  const applyClose = dialog.getByRole("button", {
    name: "保存并关闭",
    exact: true,
  });
  const add = dialog.getByRole("button", { name: "＋ 添加参数" });
  const focusIs = (locator) =>
    locator.evaluate((el) => document.activeElement === el);
  const editValue = async (row) => {
    await row
      .getByRole("button", { name: "编辑值", exact: true })
      .press("Enter");
    assert(await focusIs(value));
  };
  const open = async () => {
    await launcher.press("Enter");
    await params.press("Enter");
    assert.equal(await title.innerText(), "全局参数");
    assert.equal(await params.getAttribute("aria-current"), "page");
    assert(await focusIs(tab("Header")));
  };
  const addHeader = async () => {
    await add.press("Enter");
    assert(await focusIs(rowName(rows.last())));
    await rowName(rows.last()).fill("X-New");
  };
  await open();
  const bounds = await dialog.boundingBox();
  const nav = await navigation.boundingBox();
  assert.equal(bounds.width, 955);
  assert.equal(bounds.height, 600);
  assert.equal(nav.width, 272);
  assert.deepEqual(await dialog.getByRole("tab").allTextContents(), [
    "Header",
    "Body",
    "Query",
    "Cookie",
  ]);

  if (captures) {
    await dialog.getByText("暂无项目全局参数", { exact: true }).waitFor();
    await tab("Header").blur();
    await page.screenshot({
      path: join(captures, "env-workbench-parameters-header.png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(
      (await app.store.get(project.id)).settings,
      project.settings,
    );
  } else {
    await page.setViewportSize({ width: 430, height: 770 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      430,
    );
    assert.equal(await rowName(rows.nth(0)).inputValue(), "X-First");
    assert.equal(await rowName(rows.nth(1)).inputValue(), "X-Paused");
    assert(await enabled(rows.nth(0)).isChecked());
    assert.equal(await enabled(rows.nth(1)).isChecked(), false);
    assert.equal(
      await value.count(),
      0,
      "values are not mounted before intentional edit",
    );

    await addHeader();
    await editValue(rows.last());
    await value.fill("1");
    await stay.press("Enter");
    await page
      .getByText("Header 第 3 行的参数值必须是文本", { exact: true })
      .waitFor();
    assert.equal(await title.innerText(), "全局参数");
    assert.equal(await value.inputValue(), "1");
    await value.fill('"safe"');
    await value.press("Escape");
    assert.equal(await value.count(), 0);
    assert(await dialog.isVisible());
    await tab("Header").press("ArrowRight");
    assert.equal(await tab("Body").getAttribute("aria-selected"), "true");
    assert(await focusIs(tab("Body")));
    await dialog.getByText(/仅表单文本/).waitFor();
    await editValue(rows.first());
    await value.fill('"edited-form"');
    await tab("Body").press("ArrowRight");
    assert(await focusIs(tab("Query")));
    await editValue(rows.first());
    assert.equal(JSON.parse(await value.inputValue()), "A\r\nB");
    await tab("Query").press("End");
    assert(await focusIs(tab("Cookie")));
    assert(!(await enabled(rows.first()).isChecked()));
    await enabled(rows.first()).check();

    let confirmation = 0;
    const dismiss = (event) => {
      confirmation++;
      return event.dismiss();
    };
    page.on("dialog", dismiss);
    await globalVars.press("Enter");
    page.off("dialog", dismiss);
    assert.equal(confirmation, 1);
    assert.equal(await title.innerText(), "全局参数");
    assert(await enabled(rows.first()).isChecked());
    await stay.press("Enter");
    assert(await focusIs(tab("Cookie")));
    assert.deepEqual(snapshots, []);
    assert.deepEqual(
      (await app.store.get(project.id)).settings.globalParameters,
      globalParameters,
    );
    await tab("Cookie").press("Home");
    assert.equal(await rowName(rows.nth(2)).inputValue(), "X-New");
    await applyClose.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(
      () => document.activeElement?.id === "open-environment-settings",
    );
    assert.deepEqual(snapshots, []);
    permitSave = true;
    await page.locator("#save-project").click();
    await page
      .locator("#saved-state")
      .getByText("✓ 已保存", { exact: true })
      .waitFor();
    assert.equal(snapshots.length, 1);
    const saved = snapshots[0];
    const expected = {
      ...globalParameters,
      headers: [
        ...globalParameters.headers,
        { key: "X-New", value: "safe", enabled: true },
      ],
      form: [{ ...globalParameters.form[0], value: "edited-form" }],
      cookies: [{ ...globalParameters.cookies[0], enabled: true }],
    };
    assert.deepEqual(saved.settings.globalParameters, expected);
    for (const key of Object.keys(independent))
      assert.deepEqual(saved.settings[key], independent[key]);
    assert.equal(saved.requests[0].inheritGlobalParameters, false);
    await page.reload();
    await open();
    assert.equal(await rowName(rows.nth(2)).inputValue(), "X-New");
    assert.deepEqual(
      (await app.store.get(project.id)).settings.globalParameters,
      expected,
    );
    assert.equal(await value.count(), 0);
    await page.setViewportSize({ width: 1363, height: 1023 });
    await dialog
      .getByRole("button", { name: "目录、共享认证与脚本（设置）" })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page.locator("#parameter-scope").waitFor();
    assert(await page.locator("#shared-auth-enabled").isVisible());
    assert(await page.locator("#shared-scripts-card").count());
    assert.equal(snapshots.length, 1);
  }
  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      bounds,
      nav,
      writes: snapshots.length,
      forbidden,
      errors,
    }),
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
