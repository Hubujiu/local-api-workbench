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
const home = await mkdtemp(join(tmpdir(), "workbench-http-pre-actions-"));
let browser, app;
try {
  app = await createApp({ root: home, port: 0 });
  const owner = await app.store.create("Pre-execution fixture");
  const url = "http://127.0.0.1:38982/verification";
  const early = normalizeRequest({
    id: "new-script",
    name: "Verification",
    url,
  });
  const storedScript = "// Stored synthetic script; never run.";
  const existing = normalizeRequest({
    id: "stored-script",
    name: "Existing",
    url,
    beforeScript: storedScript,
    inheritSharedScripts: false,
    before: [{ type: "set", name: "fixtureName", value: "preserved" }],
  });
  owner.requests.push(early, existing);
  await app.store.save(owner);
  const baseline = await app.store.get(owner.id);

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  page.setDefaultTimeout(8000);
  await page.addInitScript((id) => {
    localStorage.setItem("theme", "light");
    sessionStorage.setItem("project", id);
    // Measure an event-loop turn after the application consumes the DB list,
    // not merely when Playwright receives the first transport bytes.
    window.preDBReceipts = 0;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      if (args[0] === `/api/projects/${id}/database-connections`) {
        const json = response.json.bind(response);
        response.json = async () => {
          const value = await json();
          setTimeout(() => {
            window.preDBReceipts++;
          }, 0);
          return value;
        };
      }
      return response;
    };
  }, owner.id);
  const origin = new URL(app.launchUrl).origin;
  const dbPath = `/api/projects/${owner.id}/database-connections`;
  const blocked = [],
    errors = [];
  let dbReads = 0,
    dbMode = "empty",
    releaseDB,
    dbStarted;
  page.on("pageerror", (error) => errors.push(error.name));
  await page.route("**/*", async (route) => {
    const req = route.request(),
      dest = new URL(req.url());
    if (dest.origin !== origin || req.method() !== "GET") {
      blocked.push(req.method());
      return route.abort();
    }
    if (dest.pathname !== dbPath) return route.continue();
    dbReads++;
    if (dbMode === "empty") return route.continue();
    if (dbMode === "held") {
      const held = new Promise((resolve) => {
        releaseDB = resolve;
      });
      dbStarted();
      await held;
    }
    // A synthetic UI-only authorization list. No database is registered or queried.
    return route.fulfill({
      json: [{ id: "fixture-db", name: "Fixture", type: "sqlite" }],
    });
  });
  const evidence = process.env.HTTP_PRE_ACTIONS_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = async (state) => {
    if (evidence)
      await page.screenshot({
        path: join(evidence, "http-pre-actions-" + state + ".png"),
        caret: "hide",
        animations: "disabled",
      });
  };
  const pick = (r) => page.locator(`.sidebar [data-request="${r.id}"]`).click();
  const debug = page.locator('[data-mode="debug"]');
  const pre = page.locator('.param-tabs [data-param="before"]');
  const trigger = page.locator("#http-pre-add");
  const menu = page.locator("#http-pre-menu");
  const chooser = (name) => menu.getByRole("menuitem", { name, exact: true });
  const editor = page.locator("#script-code");
  const card = page.getByRole("region", { name: "自定义脚本", exact: true });
  const savedText = () => page.locator("#saved-state").textContent();
  const active = (locator) =>
    locator.evaluate((el) => el === document.activeElement);
  const near = (actual, expected, tolerance = 3) =>
    assert(
      Math.abs(actual - expected) <= tolerance,
      JSON.stringify({ actual, expected, tolerance }),
    );

  await page.goto(app.launchUrl);
  await pick(early);
  await debug.click();
  await pre.press("Enter");
  const initial = await trigger.boundingBox();
  console.log("HTTP_PRE_ACTIONS_ADD_GEOMETRY", JSON.stringify(initial));
  near(initial.x, 371);
  near(initial.y, 233);
  near(initial.width, 976);
  near(initial.height, 40);
  assert.equal(await editor.count(), 0);
  assert.equal(await savedText(), "✓ 已保存");
  await capture("empty");
  await trigger.press("ArrowDown");
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), [
    "自定义脚本",
    "数据库",
    "等待",
  ]);
  assert.equal(await active(chooser("自定义脚本")), true);
  const popup = await menu.boundingBox();
  console.log("HTTP_PRE_ACTIONS_MENU_GEOMETRY", JSON.stringify(popup));
  near(popup.x, 749);
  near(popup.y, 285);
  near(popup.width, 218);
  near(popup.height, 114);
  await capture("menu");
  await chooser("自定义脚本").press("ArrowDown");
  assert.equal(await active(chooser("数据库")), true);
  await chooser("数据库").press("Escape");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(await active(trigger), true);
  assert.equal(dbReads, 0);

  await trigger.press("Enter");
  await chooser("自定义脚本").press("Enter");
  assert.equal(await active(editor), true);
  assert.equal(await editor.inputValue(), "");
  assert.equal(await savedText(), "✓ 已保存");
  const cardBox = await card.boundingBox();
  const cardHeader = await card.locator("header").boundingBox();
  near(cardBox.y, 233);
  near(cardHeader.height, 40);
  near((await card.getByRole("heading").boundingBox()).x, 384);
  await capture("empty-script");

  await card.getByRole("button", { name: "展开脚本编辑器" }).click();
  const dialog = page.getByRole("dialog", { name: "前置脚本编辑器" });
  await dialog.locator("#expanded-script-code").fill("// Cancel this draft.");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await editor.inputValue(), "");
  assert.equal(
    await active(card.getByRole("button", { name: "展开脚本编辑器" })),
    true,
  );
  assert.equal(await savedText(), "✓ 已保存");
  const staleEditor = await editor.elementHandle();
  await pick(existing);
  await pre.click();
  assert.equal(await editor.inputValue(), storedScript);
  await staleEditor.evaluate((el) => {
    if (el.isConnected) throw Error("Expected a detached script editor");
    el.value = "// Must not cross request.";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await editor.inputValue(), storedScript);
  assert.equal(await savedText(), "✓ 已保存");
  const advanced = page.locator("#http-pre-advanced > summary");
  await advanced.press("Enter");
  assert.equal(
    await page.locator("#inherit-shared-scripts").isChecked(),
    false,
  );
  assert.match(
    await page.locator("[data-operation-index='0']").innerText(),
    /fixtureName/,
  );
  const oldInheritance = await page
    .locator("#inherit-shared-scripts")
    .elementHandle();
  const oldRemove = await page
    .locator("[data-remove-operation='0']")
    .elementHandle();
  await page.locator("#edit-operations").click();
  const rules = page.getByRole("dialog", { name: "编辑 before", exact: true });
  await rules.waitFor();
  const staleRuleMessage = page
    .locator("#toast")
    .getByText("接口或阶段已切换，请重新打开操作编辑器", { exact: true });
  // Force the same view transition a pending repaint could produce under a
  // real modal; a physical pointer cannot reach its inert background.
  await page
    .locator('.param-tabs [data-param="after"]')
    .evaluate((tab) => tab.click());
  assert.equal(
    await page
      .locator('.param-tabs [data-param="after"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  await rules.locator("#modal-json").fill("malformed JSON must not be read");
  await rules.locator("#dialog-save").click();
  await staleRuleMessage.waitFor();
  assert.equal(await rules.isVisible(), true);
  await page
    .locator(`.sidebar [data-request="${early.id}"]`)
    .evaluate((tab) => tab.click());
  await pre.evaluate((tab) => tab.click());
  await page.locator("#toast").evaluate((el) => {
    el.style.display = "none";
  });
  await rules
    .locator("#modal-json")
    .fill('[{"type":"set","name":"mustNotCross","value":"stale"}]');
  await rules.locator("#dialog-save").click();
  await staleRuleMessage.waitFor();
  assert.equal(await rules.isVisible(), true);
  await page.keyboard.press("Escape");
  await rules.waitFor({ state: "hidden" });
  await oldInheritance.evaluate((element) => {
    if (element.isConnected)
      throw Error("Expected a detached Advanced control");
    element.checked = false;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.equal(await page.locator("[data-operation-index]").count(), 0);
  await advanced.press("Enter");
  assert.equal(await page.locator("#inherit-shared-scripts").isChecked(), true);
  assert.equal(await savedText(), "✓ 已保存");
  await pick(existing);
  await pre.click();
  let staleRemovePrompts = 0;
  const acceptUnexpectedRemove = async (popup) => {
    staleRemovePrompts++;
    await popup.accept();
  };
  page.on("dialog", acceptUnexpectedRemove);
  try {
    await oldRemove.evaluate((element) => {
      if (element.isConnected)
        throw Error("Expected a detached Remove control");
      element.click();
    });
  } finally {
    page.off("dialog", acceptUnexpectedRemove);
  }
  assert.equal(staleRemovePrompts, 0);
  assert.match(
    await page.locator("[data-operation-index='0']").innerText(),
    /fixtureName/,
  );
  assert.equal(await editor.inputValue(), storedScript);
  await pick(early);
  await pre.click();
  assert.equal(
    await editor.count(),
    0,
    "Reset prior empty editor on owner switch",
  );

  await trigger.press("ArrowDown");
  await chooser("数据库").press("Enter");
  await page
    .locator("#toast")
    .getByText("请先到配置 → 数据库连接，授权本项目的会话连接", { exact: true })
    .waitFor();
  assert.equal(dbReads, 1);
  assert.equal(await page.locator("#dialog[open]").count(), 0);
  assert.equal(await savedText(), "✓ 已保存");
  dbMode = "authorized";
  await trigger.press("ArrowDown");
  await chooser("数据库").press("Enter");
  const dbDialog = page.getByRole("dialog", { name: "添加前置数据库查询" });
  await dbDialog.waitFor();
  await dbDialog
    .getByRole("button", { name: "取消", exact: true })
    .press("Enter");
  await dbDialog.waitFor({ state: "hidden" });
  assert.equal(await page.locator("[data-operation-index]").count(), 0);
  assert.equal(await savedText(), "✓ 已保存");
  dbMode = "held";
  const started = new Promise((resolve) => {
    dbStarted = resolve;
  });
  await trigger.press("ArrowDown");
  await chooser("数据库").press("Enter");
  await started;
  await pick(existing);
  await pre.click();
  releaseDB();
  await page.waitForFunction(() => window.preDBReceipts === 3);
  assert.equal(await editor.inputValue(), storedScript);
  assert.equal(await page.locator("#dialog[open]").count(), 0);

  await pick(early);
  await pre.click();
  await page.setViewportSize({ width: 430, height: 830 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    430,
  );
  await trigger.press("Enter");
  const smallMenu = await menu.boundingBox();
  assert(smallMenu.x >= 8 && smallMenu.x + smallMenu.width <= 422);
  await chooser("自定义脚本").press("Enter");
  assert.equal(await active(editor), true);
  await capture("narrow-script");
  await editor.fill("// Authored fixture; not executed.");
  assert.equal(await savedText(), "● 未保存");
  await card.getByRole("button", { name: "收起", exact: true }).press("Enter");
  assert.equal(await editor.count(), 0);
  assert.equal(await active(trigger), true);
  await trigger.press("Enter");
  await chooser("自定义脚本").press("Enter");
  assert.equal(await editor.inputValue(), "// Authored fixture; not executed.");
  await editor.fill("");
  assert.equal(await editor.inputValue(), "");
  await pick(existing);
  await pre.click();
  assert.equal(await editor.inputValue(), storedScript);
  assert.equal(dbReads, 3);
  assert.deepEqual(await app.store.get(owner.id), baseline);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "HTTP_PRE_ACTIONS_UI_PASS owned drafts, existing order, keyboard, no execution or writes",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await app?.close();
    await rm(home, { recursive: true, force: true });
  }
}
