import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const root = await mkdtemp(join(tmpdir(), "mcp-status-overflow-"));
const app = await createApp({ root, port: 0 });
const before = process.env.MCP_STATUS_OVERFLOW_BASELINE === "1";
let browser;
try {
  const project = await app.store.create("默认项目");
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  for (const scale of [100, 110]) {
    const page = await browser.newPage({
      viewport: { width: 680, height: 848 },
      deviceScaleFactor: 1,
    });
    const origin = new URL(app.launchUrl).origin;
    const blocked = [];
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(
      (value) => localStorage.setItem("appearance-font-scale", String(value)),
      scale,
    );
    let release;
    const firstRead = new Promise((resolve) => (release = resolve));
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        url.origin !== origin ||
        request.method() !== "GET" ||
        url.pathname === "/mcp"
      ) {
        blocked.push(request.method());
        await route.abort();
        return;
      }
      if (url.pathname === "/api/mcp/config") await firstRead;
      await route.continue();
    });
    try {
      await page.goto(app.launchUrl);
      await page.waitForFunction(
        (id) =>
          document.querySelector("#project-select option[selected]")?.value ===
          id,
        project.id,
      );
      const chip = page.locator("#mcp-status");
      const announcer = page.locator("#mcp-top-announcer");
      const read = () =>
        page.evaluate(() => {
          const head = document.querySelector("header.top");
          const live = document.querySelector("#mcp-top-announcer");
          const leftRight = (node) => {
            const { left, right } = node.getBoundingClientRect();
            return [Math.round(left), Math.round(right)];
          };
          return {
            document: document.documentElement.scrollWidth,
            viewport: window.innerWidth,
            head: [
              head.clientWidth,
              head.scrollWidth,
              getComputedStyle(head).overflowX,
            ],
            groups: Array.from(head.children, leftRight),
            status: leftRight(head.querySelector("#mcp-status")),
            live: leftRight(live),
            liveParent: live.offsetParent?.tagName,
            scale: Number(document.documentElement.dataset.appFontScale ?? 100),
          };
        });
      const verify = async (kind) => {
        const values = await read();
        console.log(
          "MCP_STATUS_OVERFLOW",
          before ? "before" : "after",
          scale,
          kind,
          JSON.stringify(values),
        );
        assert.equal(values.viewport, 680);
        assert.equal(values.scale, scale);
        assert.equal(values.head[0], 680);
        assert.equal(values.head[2], "auto");
        if (before) {
          assert(values.document > values.viewport);
          assert(values.live[1] > values.viewport);
          await announcer.evaluate((node) => {
            node.style.insetBlockStart = "0";
            node.style.insetInlineStart = "0";
          });
          const isolated = await read();
          console.log(
            "MCP_STATUS_OVERFLOW",
            "isolated-announcer",
            scale,
            kind,
            JSON.stringify(isolated),
          );
          assert.equal(isolated.document, 680);
          assert.deepEqual(isolated.head, values.head);
          await announcer.evaluate((node) => node.removeAttribute("style"));
        } else {
          assert.equal(values.document, 680);
          assert.deepEqual(values.live, [0, 1]);
        }
      };
      assert.equal(await chip.getAttribute("data-mcp-state"), "loading");
      assert.equal(await announcer.getAttribute("aria-live"), "polite");
      await verify("loading");
      release();
      await page.locator('#mcp-status[data-mcp-state="off"]').waitFor();
      assert.equal(await announcer.textContent(), "MCP · 未开启");
      await verify("off");
      await chip.press("Enter");
      await page
        .locator("#settings-mcp .mcp-service-card")
        .getByText("已关闭", { exact: true })
        .waitFor();
      assert.deepEqual(blocked, []);
      assert.deepEqual(errors, []);
    } finally {
      release();
      await page.close();
    }
  }
  console.log(
    "MCP_STATUS_OVERFLOW_UI_PASS 680/100+110/loading+off/header-local-scroll/accessible-no-writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
