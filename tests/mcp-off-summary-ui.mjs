import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp("/tmp/workbench-mcp-off-summary-");
const app = await createApp({ root, port: 0 });
let browser;
try {
  const project = await app.store.create("默认项目");
  const before = await app.store.get(project.id);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1363, height: 1023 },
    deviceScaleFactor: 1,
  });
  const origin = new URL(app.launchUrl).origin;
  const blocked = [];
  const errors = [];
  let configReads = 0;
  page.on("pageerror", () => errors.push("unexpected page error"));
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.origin === origin &&
      request.method() === "GET" &&
      url.pathname !== "/mcp" &&
      !url.pathname.includes("/mcp-database-connections") &&
      (!url.pathname.startsWith("/api/mcp/") ||
        url.pathname === "/api/mcp/config")
    ) {
      if (url.pathname === "/api/mcp/config") configReads++;
      return route.continue();
    }
    blocked.push(request.method());
    return route.abort();
  });
  await page.goto(app.launchUrl);
  await page.locator("#mcp-status").press("Enter");
  const summary = page.locator("#settings-mcp");
  const service = summary.locator(".mcp-service-card");
  const grants = summary.locator(".mcp-grants");
  const clients = summary.locator(".mcp-client-card");
  const db = summary.locator("#mcp-database-panel");
  const editor = clients.getByRole("button", {
    name: "编辑授权与服务",
    exact: true,
  });
  const publicTabs = clients.getByRole("tablist", {
    name: "MCP 客户端",
    exact: true,
  });
  const code = clients.locator("#mcp-inline-code");
  const disabled = async () => {
    assert(
      await clients.getByRole("button", { name: "查看本机配置" }).isDisabled(),
    );
    assert(
      await clients.getByRole("button", { name: "复制配置" }).isDisabled(),
    );
    assert(
      await code.evaluate(
        (node) =>
          node.textContent.startsWith("连接密钥默认隐藏。") &&
          !node.textContent.includes("Bearer"),
      ),
    );
    assert(await db.locator("#mcp-db-fields [name=name]").isDisabled());
    assert(await db.getByRole("button", { name: "确认临时授权" }).isDisabled());
  };
  await service.getByText("已关闭", { exact: true }).waitFor();
  assert(
    await service
      .getByText("最近活动：暂无连接记录", { exact: true })
      .isVisible(),
  );
  assert.equal(await service.getByRole("switch").count(), 0);
  await grants.getByText("尚未授权项目", { exact: true }).waitFor();
  assert.deepEqual(await grants.locator("dl dd").allTextContents(), [
    "未允许",
    "未允许",
    "未开启",
  ]);
  assert.equal(
    await summary.locator("#mcp-live-summary #mcp-config").count(),
    0,
  );
  assert(await editor.isEnabled());
  assert.equal(
    await db.evaluate(
      (element) => getComputedStyle(element, "::before").content,
    ),
    "none",
  );
  const measurements = await summary.evaluate((region) => {
    const box = (selector) => {
      const { x, y, width, height } = region
        .querySelector(selector)
        .getBoundingClientRect();
      return [x, y, width, height].map((value) => Number(value.toFixed(2)));
    };
    return {
      notice: box(".mcp-local-notice"),
      service: box(".mcp-service-card"),
      serviceHeading: box(".mcp-service-head"),
      serviceActivity: box(".mcp-service-activity"),
      grants: box(".mcp-grants"),
      grantScopes: box(".mcp-grants dl"),
      grantedProjects: box(".mcp-grants ul"),
      clients: box(".mcp-client-card"),
      database: box("#mcp-database-panel"),
    };
  });
  console.log("MCP_OFF_SUMMARY_BOUNDS", JSON.stringify(measurements));
  const bounds = Object.fromEntries(
    Object.entries(measurements).map(([key, box]) => [
      key,
      box.map(Math.round),
    ]),
  );
  assert.deepEqual(bounds.notice, [357, bounds.notice[1], 972, 38]);
  assert(Math.abs(bounds.notice[1] - 152) <= 4);
  assert.equal(bounds.service[1] - bounds.notice[1] - bounds.notice[3], 20);
  assert.equal(bounds.service[3], 183);
  assert.equal(bounds.grants[1] - bounds.service[1] - bounds.service[3], 20);
  assert.equal(bounds.grants[3], 198);
  assert.equal(bounds.clients[1] - bounds.grants[1] - bounds.grants[3], 20);
  await disabled();

  // Polling may replace the summaries, never the separate real editor button.
  await editor.focus();
  const originalEditor = await editor.elementHandle();
  await page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/mcp/config" &&
      response.request().method() === "GET",
  );
  assert(
    await originalEditor.evaluate(
      (button) =>
        button === document.querySelector("#mcp-config") &&
        button === document.activeElement,
    ),
  );
  await page.setViewportSize({ width: 430, height: 760 });
  await publicTabs
    .getByRole("tab", { name: "Codex", exact: true })
    .press("ArrowRight");
  assert.equal(
    await publicTabs
      .getByRole("tab", { name: "Claude Code", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  assert.equal(await publicTabs.getByRole("tab").count(), 6);
  await disabled();
  assert.equal(
    await summary.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
    0,
  );
  assert.equal(
    (await app.store.get(project.id)).configRevision,
    before.configRevision,
  );
  assert(configReads > 0);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log("MCP_OFF_SUMMARY_PASS real-poll/disabled/430/safe-no-mutations");
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
