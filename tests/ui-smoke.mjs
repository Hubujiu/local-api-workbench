import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
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
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_BUNDLED
    ? undefined
    : process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
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
  await page.goto(app.url);
  await page.getByRole("button", { name: "发 送", exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/local-api-initial.png" });
  await page.getByRole("button", { name: "发 送", exact: true }).click();
  await page.getByText("欢迎使用 Local API", { exact: false }).last().waitFor();
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
  await page.getByRole("button", { name: "＋ 新建计划", exact: true }).click();
  await page.locator("#plan-name").fill("可重复验证");
  await page.locator("#dialog-save").click();
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
      'pm.test("payload", () => pm.expect(pm.response.code).to.equal(200)); console.log("script-done");',
    );
  await page.locator("#send").click();
  await page.locator('[data-response="logs"]').click();
  await page.getByText("script-done", { exact: false }).last().waitFor();
  await saveAndWait("#save");
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
  await page.locator("#theme").click();
  assert(
    await page
      .locator("body")
      .evaluate((element) => element.classList.contains("dark")),
  );
  await page.screenshot({ path: "/tmp/local-api-dark.png" });
  await page.setViewportSize({ width: 1000, height: 760 });
  assert(await page.locator("#send").isVisible());
  await page.screenshot({ path: "/tmp/local-api-compact.png" });
  await page.locator('[data-page="docs"]').click();
  await page.locator("#new-document").click();
  await page.locator("#document-title").fill("本地文档测试");
  await page.locator("#document-content").fill("# 文档\n\n保存在本地。");
  await page.locator("#dialog-save").click();
  await page.getByText("本地文档测试", { exact: true }).waitFor();
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
  assert.deepEqual(errors, []);
  console.log("UI_SMOKE_PASS");
} finally {
  await browser.close();
  await new Promise((r) => app.server.close(r));
  await rm(root, { recursive: true, force: true });
}
