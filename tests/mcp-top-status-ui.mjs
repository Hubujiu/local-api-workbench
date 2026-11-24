import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.MCP_TOP_STATUS_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-mcp-top-status-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  let project = await app.store.create("默认项目");
  project.requests = [
    normalizeRequest({
      id: "fixture",
      name: "Verification",
      method: "GET",
      url: "http://127.0.0.1:38982/no-send",
    }),
  ];
  project = await app.store.save(project);
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 1363, height: 1023 },
      deviceScaleFactor: 1,
    });
    const origin = new URL(app.launchUrl).origin;
    const blocked = [],
      pageErrors = [];
    let release;
    const holdOff = new Promise((resolve) => (release = resolve));
    let mode = "first-read";
    const receipt = {
      enabled: true,
      warning: "",
      write: false,
      execute: false,
      remember: false,
      projects: [],
      activities: [],
    };
    page.on("pageerror", () => pageErrors.push("unexpected page error"));
    await page.addInitScript(
      (choice) => localStorage.setItem("theme", choice),
      theme,
    );
    await page.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (
        url.origin !== origin ||
        request.method() !== "GET" ||
        url.pathname === "/mcp" ||
        (url.pathname.startsWith("/api/mcp/") &&
          url.pathname !== "/api/mcp/config") ||
        url.pathname.includes("/mcp-database-connections")
      ) {
        blocked.push(request.method());
        return route.abort();
      }
      if (url.pathname !== "/api/mcp/config") return route.continue();
      if (mode === "first-read") {
        await holdOff;
        return route.continue();
      }
      if (mode === "off") return route.continue();
      if (mode === "unavailable")
        return route.fulfill({
          status: 503,
          json: { error: "test current read unavailable" },
        });
      return route.fulfill({
        json:
          mode === "running"
            ? {
                ...receipt,
                enabled: false,
                activities: [{ status: "running" }],
              }
            : receipt,
      });
    });
    try {
      await page.goto(app.launchUrl);
      const status = page.locator("#mcp-status");
      const label = status.locator("#mcp-top-status-text");
      const announcer = page.locator("#mcp-top-announcer");
      const wait = async (state, text) => {
        await page.locator(`#mcp-status[data-mcp-state="${state}"]`).waitFor();
        assert.equal(await label.textContent(), text);
        assert.equal(
          await status.getAttribute("data-settings-target"),
          "settings-mcp",
        );
      };
      await wait("loading", "MCP · 读取中");
      assert.equal(await announcer.getAttribute("aria-live"), "polite");
      const original = await status.elementHandle();
      mode = "off";
      release();
      await wait("off", "MCP · 未开启");
      await page.mouse.move(830, 490);
      const visibleOff = await status.evaluate((button) => {
        const style = getComputedStyle(button);
        const indicator = getComputedStyle(button, "::before");
        const { y, height } = button.getBoundingClientRect();
        return {
          background: style.backgroundColor,
          ink: style.color,
          dot: [indicator.width, indicator.height],
          y,
          height,
        };
      });
      console.log("MCP_TOP_STATUS_OFF", theme, JSON.stringify(visibleOff));
      assert.equal(visibleOff.background, "rgba(0, 0, 0, 0)");
      assert.deepEqual(visibleOff.dot, ["6px", "6px"]);
      assert.equal(Math.round(visibleOff.y + visibleOff.height / 2), 22);
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({
          path: join(evidence, `${theme}-off-header.png`),
          clip: { x: 970, y: 0, width: 393, height: 44 },
          caret: "hide",
        });
      }
      await page.locator("#request-name").fill("Unsaved verification draft");
      await status.focus();
      mode = "enabled";
      await wait("enabled", "MCP · 已开启");
      assert(
        await original.evaluate(
          (button) => button === document.activeElement && button.isConnected,
        ),
      );
      mode = "running";
      await wait("running", "MCP · 1 个任务运行中");
      mode = "unavailable";
      await wait("unavailable", "MCP · 状态不可用");
      assert.equal(await announcer.textContent(), "MCP · 状态不可用");
      assert(
        await original.evaluate(
          (button) => button === document.activeElement && button.isConnected,
        ),
      );
      assert.equal(
        await page.locator("#request-name").inputValue(),
        "Unsaved verification draft",
      );
      mode = "off";
      await wait("off", "MCP · 未开启");
      await status.press("Enter");
      await page
        .locator("#settings-mcp .mcp-service-card")
        .getByText("已关闭", { exact: true })
        .waitFor();
      await page.locator('.rail [data-page="apis"]').press("Enter");
      assert.equal(
        await page.locator("#request-name").inputValue(),
        "Unsaved verification draft",
      );
      assert.deepEqual(blocked, []);
      assert.deepEqual(pageErrors, []);
      assert.equal(
        (await app.store.get(project.id)).configRevision,
        project.configRevision,
      );
    } finally {
      release();
      await page.close();
    }
  }
  console.log(
    "MCP_TOP_STATUS_UI_PASS native-off-dot/light-dark/read-only-loading-enabled-running-unavailable-recovery/focus/draft",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
