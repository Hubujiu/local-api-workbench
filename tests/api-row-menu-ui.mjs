import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
import { normalizeProtocol } from "../src/protocol-definitions.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "api-row-menu-"));
let app, browser;
try {
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("默认项目");
  const base = "http://127.0.0.1:1";
  const requestId = "trash-visual-fixture",
    requestName = "Trash Visual Fixture";
  for (const [id, name, method] of [
    ["verification", "Verification", "GET"],
    ["create", "创建用户", "POST"],
    ["read", "获取用户信息", "GET"],
    ["update", "修改用户信息", "PUT"],
    ["delete", "删除用户", "DELETE"],
    [requestId, requestName, "POST"],
  ]) {
    const root = id === requestId || id === "verification";
    project.requests.push(
      normalizeRequest({
        id,
        name,
        method,
        url: base + "/" + id,
        folder: root ? "" : "示例接口",
        ...(id === requestId
          ? {
              bodyType: "json",
              body: '{"fixture":"synthetic"}',
              headers: [{ key: "X-Visual-Fixture", value: "local" }],
              description: "合成接口，无凭证",
            }
          : {}),
      }),
    );
  }
  project.documents.push({
    id: "fixture-document",
    title: "什么是Apipost单机版？",
    content: "# 合成测试文档",
  });
  project.protocols.push(
    normalizeProtocol({
      id: "sse-fixture",
      type: "sse",
      name: "SSE调试示例",
      folder: "示例接口",
      url: base + "/sse",
    }),
  );
  await app.store.save(project);
  const initial = await app.store.get(project.id);
  const other = await app.store.create("另一个合成项目");
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
  });
  page.setDefaultTimeout(7500);
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  const origin = new URL(app.launchUrl).origin,
    blocked = [],
    errors = [],
    metrics = {};
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (req.method() === "GET" && url.origin === origin)
      return route.continue();
    blocked.push([req.method(), url.pathname]);
    return route.abort();
  });
  await page.goto(app.launchUrl);
  await page.locator("#project-select").selectOption(project.id);
  const editor = page.locator("#request-name");
  const row = page.locator(`[data-request="${requestId}"]`);
  const trigger = page.locator(`[data-api-row-menu="${requestId}"]`);
  const menu = page.getByRole("menu", { name: "接口操作", exact: true });
  const clone = menu.getByRole("menuitem", { name: "克隆", exact: true });
  const remove = menu.getByRole("menuitem", { name: "删除", exact: true });
  const dialog = page.locator("#dialog");
  const cancel = dialog.getByRole("button", { name: "取消", exact: true });
  const focus = (control) =>
    control.evaluate((node) => node === document.activeElement);
  const prefix = process.env.API_ROW_MENU_CAPTURE_PREFIX;
  const capture = async (name, narrow = false) => {
    if (!prefix) return;
    await page.mouse.move(narrow ? 412 : 800, 75);
    await page.screenshot({
      path: prefix + "-" + name + ".png",
      animations: "disabled",
      caret: "hide",
      ...(narrow ? {} : { clip: { x: 0, y: 0, width: 1363, height: 980 } }),
    });
  };
  await row.click();
  await trigger.click();
  await menu.waitFor();
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), [
    "克隆",
    "删除",
  ]);
  assert.equal(await focus(clone), true);
  assert.equal(await editor.inputValue(), requestName);
  assert.match(await page.locator("#saved-state").innerText(), /已保存/);
  metrics.desktop = await menu.boundingBox();
  metrics.trigger = await trigger.boundingBox();
  console.log("API row menu geometry", JSON.stringify(metrics));
  await capture("menu");
  assert.equal(metrics.desktop.width, 133);
  assert.ok(metrics.desktop.y >= metrics.trigger.y);
  assert.ok(
    Math.abs(
      metrics.desktop.x +
        metrics.desktop.width -
        (metrics.trigger.x + metrics.trigger.width / 2 - 2),
    ) <= 2,
    JSON.stringify(metrics),
  );
  await page.keyboard.press("ArrowDown");
  assert.equal(await focus(remove), true);
  await page.keyboard.press("Home");
  assert.equal(await focus(clone), true);
  await page.keyboard.press("End");
  assert.equal(await focus(remove), true);
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+Enter");
  assert.equal(await menu.isVisible(), true);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await focus(trigger), true);
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");

  await trigger.press("ArrowUp");
  assert.equal(await focus(remove), true);
  await page.keyboard.press("Enter");
  await dialog
    .getByText("确定将 " + requestName + " 移到回收站？", { exact: true })
    .waitFor();
  assert.equal(await focus(cancel), true);
  await capture("confirm");
  await cancel.click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await focus(trigger), true);
  await row.waitFor();
  await capture("cancel");

  await trigger.press("Enter");
  await page.getByRole("button", { name: "执行计划", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  await page.locator('.rail [data-page="apis"]').click();
  await trigger.waitFor();
  await page.setViewportSize({ width: 430, height: 760 });
  await trigger.click();
  await menu.waitFor();
  metrics.narrow = await menu.boundingBox();
  assert.ok(
    metrics.narrow.x >= 0 &&
      metrics.narrow.x + metrics.narrow.width <= 430 &&
      metrics.narrow.y >= 0 &&
      metrics.narrow.y + metrics.narrow.height <= 760,
    JSON.stringify(metrics),
  );
  await capture("narrow", true);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1363, height: 1023 });

  // A render owned by another project cannot continue an open row menu.
  await trigger.click();
  await page.locator("#project-select").selectOption(other.id);
  await trigger.waitFor({ state: "detached" });
  assert.equal(await menu.isVisible(), false);
  await page.locator("#project-select").selectOption(project.id);
  await trigger.waitFor();
  const verification = page.locator('[data-request="verification"]');
  await verification.click();
  await editor.fill("未保存的 Verification 草稿");
  await trigger.click();
  assert.equal(await editor.inputValue(), "未保存的 Verification 草稿");
  await clone.click();
  assert.equal(await editor.inputValue(), requestName + " 副本");
  assert.equal(await page.locator("#method").inputValue(), "POST");
  assert.equal(await page.locator("#url").inputValue(), base + "/" + requestId);
  await page.locator('[data-param="headers"]').click();
  assert.equal(
    await page.locator('[data-pair="headers:0:key"]').inputValue(),
    "X-Visual-Fixture",
  );
  await page.locator('[data-param="body"]').click();
  assert.equal(
    await page.locator("#body-code").inputValue(),
    '{"fixture":"synthetic"}',
  );
  await verification.click();
  assert.equal(await editor.inputValue(), "未保存的 Verification 草稿");
  await trigger.click();
  await remove.click();
  assert.equal(await editor.inputValue(), "未保存的 Verification 草稿");
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await row.count(), 0);
  assert.equal(await editor.inputValue(), "未保存的 Verification 草稿");
  assert.match(await page.locator("#saved-state").innerText(), /未保存/);
  assert.deepEqual(await app.store.get(project.id), initial);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  if (prefix)
    await writeFile(
      prefix + ".json",
      JSON.stringify({ metrics, blocked, errors }, null, 2) + "\n",
    );
  console.log(
    "API_ROW_MENU_UI_PASS 133px/430/cancel-focus/fenced-project/inactive-clone-and-trash/draft-only/no-dispatch",
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
