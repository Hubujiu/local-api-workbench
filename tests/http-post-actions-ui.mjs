import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRequest } from "../src/core.mjs";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const home = await mkdtemp(join(tmpdir(), "workbench-post-actions-"));
const app = await createApp({ root: home, port: 0 });
const origin = new URL(app.launchUrl).origin;
const blocked = [],
  errors = [];
let browser;
try {
  let owner = await app.store.create("操作布局验证");
  owner.requests = [
    normalizeRequest({
      id: "verification",
      name: "Verification",
      url: "",
      method: "GET",
      bodyType: "json",
      body: '{ "fixture": 9007199254740993 }',
      beforeScript: "const original = 1;",
    }),
    normalizeRequest({
      id: "existing",
      name: "Configured",
      url: "",
      method: "GET",
      afterScript: "const savedFixture = 1;",
      after: [{ type: "set", name: "fixtureValue", value: "existing" }],
    }),
  ];
  owner = await app.store.save(owner);
  const baseline = await app.store.get(owner.id);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  await page.addInitScript(
    (id) => sessionStorage.setItem("project", id),
    owner.id,
  );
  await page.route("**/*", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (
      url.origin === origin &&
      req.method() === "GET" &&
      !/database|execute/.test(url.pathname)
    )
      return route.continue();
    blocked.push(req.method());
    return route.abort();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.launchUrl);
  const editor = page.locator("[data-http-response-layout]");
  const tab = (key) => editor.locator(`[data-param="${key}"]`);
  const panel = editor.getByRole("region", {
    name: "后执行操作工作区",
    exact: true,
  });
  const trigger = panel.getByRole("button", {
    name: "添加操作项",
    exact: true,
  });
  const menu = page.getByRole("menu", { name: "添加操作项", exact: true });
  const item = (label) =>
    menu.getByRole("menuitem", { name: label, exact: true });
  const disclosure = panel
    .locator("summary")
    .filter({ hasText: "脚本与高级设置" });
  const postCode = panel.getByRole("textbox", {
    name: "接口脚本",
    exact: true,
  });
  const url = editor.getByRole("textbox", { name: "请求 URL", exact: true });
  const dialog = page.getByRole("dialog", {
    name: "后置脚本编辑器",
    exact: true,
  });
  const modalCode = dialog.getByRole("textbox", {
    name: "JavaScript",
    exact: true,
  });
  const active = (locator) =>
    locator.evaluate((node) => node === document.activeElement);
  const capture = async (label) => {
    const target = process.env.HTTP_POST_ACTIONS_EVIDENCE;
    if (!target) return;
    await mkdir(target, { recursive: true });
    await page.screenshot({
      path: join(target, "http-post-actions-" + label + ".png"),
      caret: "hide",
      animations: "disabled",
    });
  };

  await page.locator('[data-request="verification"]').click();
  await page.locator('[data-mode="debug"]').press("Enter");
  await tab("after").press("Enter");
  assert.equal(await trigger.isVisible(), true);
  assert.equal(await postCode.isVisible(), false);
  assert.equal(await panel.locator(".operation-card").count(), 0);
  assert.equal(
    await panel
      .getByText("脚本在沙箱运行；数据库只读操作需要单独授权。")
      .isVisible(),
    true,
  );
  const add = await trigger.boundingBox();
  console.log("HTTP_POST_ACTIONS_BUTTON", JSON.stringify(add));
  await capture("empty-desktop");
  assert(Math.abs(add.x - 371) <= 2 && Math.abs(add.y - 233) <= 3);
  assert(Math.abs(add.width - 976) <= 2);
  assert.equal(add.height, 40);
  await trigger.press("ArrowDown");
  await menu.waitFor();
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), [
    "自定义脚本",
    "打开断言",
    "打开提取变量",
  ]);
  const desktop = await menu.boundingBox();
  console.log("HTTP_POST_ACTIONS_MENU", JSON.stringify(desktop));
  await capture("open-desktop");
  assert(Math.abs(desktop.x - 749) <= 3 && Math.abs(desktop.y - 285) <= 4);
  assert.equal(desktop.width, 218);
  assert.equal(await active(item("自定义脚本")), true);
  await item("自定义脚本").press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await active(trigger), true);
  await trigger.click();
  await menu.waitFor();
  await url.click();
  await menu.waitFor({ state: "hidden" });
  assert.equal(await active(url), true);
  await url.fill("{{visual-fixture-base}}/draft");

  await trigger.press("Enter");
  await item("自定义脚本").press("Enter");
  await dialog.waitFor();
  assert.equal(await active(modalCode), true);
  assert.equal(await modalCode.inputValue(), "");
  await modalCode.fill("const notApplied = true;");
  await capture("script-editor");
  await modalCode.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await active(trigger), true);
  await disclosure.press("Enter");
  assert.equal(await postCode.inputValue(), "");
  assert.equal(
    await panel
      .getByRole("button", { name: "添加数据库查询", exact: true })
      .isVisible(),
    true,
  );
  assert.equal(
    await panel.getByText(/JavaScript 沙箱 · 无文件访问/).isVisible(),
    true,
  );
  await disclosure.press("Enter");

  await trigger.press("ArrowDown");
  await item("自定义脚本").press("Enter");
  const localScript = "const localOnly = true;";
  await modalCode.fill(localScript);
  await dialog
    .getByRole("button", { name: "应用到接口", exact: true })
    .press("Enter");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await active(trigger), true);
  assert.equal(
    await panel.getByText("已配置后置 JavaScript").isVisible(),
    true,
  );
  assert.equal(await postCode.isVisible(), false);
  await trigger.press("ArrowDown");
  await item("自定义脚本").press("ArrowDown");
  await item("打开断言").press("Enter");
  assert.equal(await tab("assertions").getAttribute("aria-pressed"), "true");
  assert.equal(await active(tab("assertions")), true);
  assert.equal(await editor.locator("[data-rule]").count(), 0);
  await tab("after").press("Enter");
  await trigger.press("ArrowUp");
  assert.equal(await active(item("打开提取变量")), true);
  await item("打开提取变量").press("Enter");
  assert.equal(await tab("extract").getAttribute("aria-pressed"), "true");
  assert.equal(await editor.locator("[data-extract]").count(), 0);

  await tab("body").press("Enter");
  assert.equal(
    await editor
      .getByRole("textbox", { name: "请求体", exact: true })
      .inputValue(),
    '{ "fixture": 9007199254740993 }',
  );
  assert.equal(await url.inputValue(), "{{visual-fixture-base}}/draft");
  await tab("before").press("Enter");
  assert.equal(
    await editor.locator("#script-code").inputValue(),
    "const original = 1;",
  );
  assert.equal(await trigger.count(), 0);
  await tab("after").press("Enter");
  await disclosure.press("Enter");
  assert.equal(await postCode.inputValue(), localScript);
  await disclosure.press("Enter");

  await page.locator("#response-layout").press("Enter");
  await trigger.press("Enter");
  await menu.waitFor();
  assert.equal(await menu.isVisible(), true);
  await item("自定义脚本").press("Escape");
  await page.setViewportSize({ width: 430, height: 830 });
  await trigger.press("Enter");
  await menu.waitFor();
  const narrow = await menu.boundingBox();
  assert(narrow.x >= 8 && narrow.x + narrow.width <= 422);
  assert(narrow.y >= 8 && narrow.y + narrow.height <= 822);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await capture("open-narrow");
  await item("自定义脚本").press("Escape");
  await page.setViewportSize({ width: 1363, height: 1023 });
  await page.locator('[data-request="existing"]').click();
  await tab("after").press("Enter");
  assert.match(
    await panel.locator(".operation-card").textContent(),
    /fixtureValue/,
  );
  assert.equal(
    await panel.getByText("已配置后置 JavaScript").isVisible(),
    true,
  );
  await disclosure.press("Enter");
  assert.equal(await postCode.inputValue(), "const savedFixture = 1;");
  await page.locator('[data-request="verification"]').click();
  await tab("after").press("Enter");
  await trigger.press("Enter");
  await item("自定义脚本").press("Enter");
  assert.equal(await modalCode.inputValue(), localScript);
  await modalCode.press("Escape");
  assert.deepEqual(await app.store.get(owner.id), baseline);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "HTTP_POST_ACTIONS_UI_PASS real draft-only editor/navigation; no send, DB or project writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(home, { recursive: true, force: true });
}
