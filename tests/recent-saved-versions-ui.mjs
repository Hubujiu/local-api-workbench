import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.RECENT_SAVED_EVIDENCE;
const root = await mkdtemp("/tmp/workbench-recent-saved-");
const app = await createApp({ root, port: 0 });
let browser;
try {
  let owner = await app.store.create("默认项目");
  const other = await app.store.create("另一个合成项目");
  owner.requests = [
    normalizeRequest({
      id: "verification",
      name: "Verification",
      method: "GET",
      url: "http://127.0.0.1:38982/no-send",
    }),
    normalizeRequest({
      id: "initial",
      name: "Initial fixture",
      method: "POST",
      url: "http://127.0.0.1:38982/not-executed",
    }),
  ];
  owner = await app.store.save(owner);
  owner.requests[0].name = "Verification recorded";
  owner = await app.store.save(owner);
  const ownerUri = "/api/projects/" + owner.id + "/recent-saved-definitions";
  const otherUri = "/api/projects/" + other.id + "/recent-saved-definitions";
  const ver = owner.requestDefinitionHistory.entries.find(
    (entry) => entry.requestId === "verification",
  );
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const origin = new URL(app.launchUrl).origin;
  const blocked = [];
  const errors = [];
  const openPage = async () => {
    const page = await browser.newPage({
      viewport: { width: 1363, height: 1023 },
      deviceScaleFactor: 1,
    });
    await page.route("**/*", (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin === origin && request.method() === "GET")
        return route.continue();
      blocked.push(request.method());
      return route.abort();
    });
    page.on("pageerror", () => errors.push("page error"));
    await page.goto(app.launchUrl);
    return page;
  };
  const adopt = async (page, expected) => {
    const selector = page.locator("#project-select");
    if (
      (await selector.locator("option[selected]").getAttribute("value")) ===
      expected
    )
      return;
    await selector.selectOption(expected);
    await page.waitForFunction(
      (id) =>
        document.querySelector("#project-select option[selected]")?.value ===
        id,
      expected,
    );
  };
  const openRecent = (page) =>
    page.locator('.rail [data-page="history"]').press("Enter");
  const saved = (page) =>
    page.getByRole("tab", { name: "已保存版本", exact: true });
  const savedPanel = (page) =>
    page.getByRole("tabpanel", { name: "已保存版本", exact: true });
  const page = await openPage();
  await adopt(page, owner.id);
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/projects/"))
      requests.push([request.method(), url.pathname]);
  });
  await page.locator("#request-name").fill("Only a local unsaved name");
  await page
    .locator("#saved-state")
    .getByText("● 未保存", { exact: true })
    .waitFor();
  await openRecent(page);
  await page.getByRole("tab", { name: "历史发送记录" }).press("ArrowRight");
  const panel = savedPanel(page);
  await panel.getByText("Verification recorded", { exact: true }).waitFor();
  assert.equal(await saved(page).getAttribute("aria-selected"), "true");
  assert.equal(await panel.getByText("Only a local unsaved name").count(), 0);
  const row = panel
    .locator("[data-recent-history-row]")
    .filter({ hasText: "Verification recorded" });
  assert.equal(
    await row.locator("time").getAttribute("datetime"),
    ver.currentCreatedAt,
  );
  assert(await row.getByText("已记录版本 2", { exact: true }).isVisible());
  assert(
    await panel.getByText("起始版本（首次记录）", { exact: true }).isVisible(),
  );
  assert.equal(await panel.locator("[data-history]").count(), 0);
  const bounds = () =>
    panel.evaluate((node) => {
      const rect = (selector) =>
        node.querySelector(selector).getBoundingClientRect();
      return {
        dayY: Math.round(rect(".recent-history-day > summary").top),
        timelineBottom: Math.round(rect("#recent-saved-list").bottom),
        infoTop: Math.round(rect("#recent-saved-info").top),
      };
    });
  const desktop = await bounds();
  console.log("RECENT_SAVED_LAYOUT", JSON.stringify(desktop));
  assert.equal(desktop.dayY, 108);
  assert(desktop.infoTop >= desktop.timelineBottom);
  assert(
    await panel
      .getByText("首次记录可能来自旧项目建立追踪", { exact: false })
      .isVisible(),
  );
  assert(
    await panel.getByRole("button", { name: "重新读取已保存版本" }).isEnabled(),
  );

  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: join(evidence, "recent-workbench-saved-versions.png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
    });
  }
  await page.setViewportSize({ width: 430, height: 760 });
  const narrow = await bounds();
  assert(narrow.infoTop >= narrow.timelineBottom);
  const search = page.getByRole("searchbox", { name: "按已保存接口名称筛选" });
  const initial = panel.getByText("Initial fixture", { exact: true });
  const initialDay = panel
    .locator(".recent-history-day")
    .filter({ has: page.getByText("Initial fixture", { exact: true }) });
  await initialDay.locator("summary").press("Enter");
  assert(await initial.isHidden());
  await search.fill("INITIAL");
  assert(await initial.isVisible());
  assert(await row.isHidden());
  assert.equal(
    await page.locator("#recent-history-count").textContent(),
    "匹配 1 / 2 条记录",
  );
  await search.fill("no-send");
  await panel.getByText("暂无符合名称的已保存版本", { exact: true }).waitFor();
  await search.clear();
  assert(await initial.isHidden(), "clear must restore saved disclosure");
  await initialDay.locator("summary").press("Enter");
  assert(await initial.isVisible());
  assert.equal(
    await page
      .locator(".recent-workspace")
      .evaluate((node) => node.scrollWidth - node.clientWidth),
    0,
  );
  await page.setViewportSize({ width: 1363, height: 1023 });
  await page.locator('.rail [data-page="apis"]').press("Enter");
  assert.equal(
    await page.locator("#request-name").inputValue(),
    "Only a local unsaved name",
  );
  assert.deepEqual(requests, [["GET", ownerUri]]);

  const stale = await openPage();
  await adopt(stale, owner.id);
  let held, release;
  const arrived = new Promise((resolve) => (held = resolve));
  const continueOld = new Promise((resolve) => (release = resolve));
  await stale.route(
    (url) => url.pathname === ownerUri,
    async (route) => {
      held();
      await continueOld;
      await route.continue();
    },
  );
  await openRecent(stale);
  await saved(stale).press("Enter");
  try {
    await Promise.race([
      arrived,
      stale
        .getByText("未能读取当前项目的已保存版本。", { exact: true })
        .waitFor({ timeout: 10000 })
        .then(() => {
          throw Error("Held owner metadata not admitted");
        }),
    ]);
    await adopt(stale, other.id);
    await saved(stale).press("Enter");
    const different = savedPanel(stale);
    await different.getByText("暂无已记录版本", { exact: true }).waitFor();
    assert(
      await different.evaluate((node) =>
        Boolean(
          node
            .querySelector("#recent-saved-info")
            .compareDocumentPosition(node.querySelector("#recent-saved-list")) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ),
      "unpopulated state must retain warning and retry before empty content",
    );

    const completed = stale.waitForResponse(
      (response) => new URL(response.url()).pathname === ownerUri,
    );
    release();
    await completed;
    assert.equal(
      await different
        .getByText("Verification recorded", { exact: true })
        .count(),
      0,
    );
  } finally {
    release();
  }
  await stale.route(
    (url) => url.pathname === otherUri,
    (route) => route.abort(),
    { times: 1 },
  );
  await savedPanel(stale)
    .getByRole("button", { name: "重新读取已保存版本" })
    .press("Enter");
  await savedPanel(stale)
    .getByText("未能读取当前项目的已保存版本。", { exact: true })
    .waitFor();
  assert.equal(
    await savedPanel(stale)
      .getByText("暂无已记录版本", { exact: true })
      .count(),
    0,
  );
  await savedPanel(stale)
    .getByRole("button", { name: "重新读取已保存版本" })
    .press("Enter");
  await savedPanel(stale)
    .getByText("暂无已记录版本", { exact: true })
    .waitFor();
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  assert.equal(
    (await app.store.get(owner.id)).configRevision,
    owner.configRevision,
  );
  console.log(
    "RECENT_SAVED_VERSIONS_PASS persisted/first-record/filter/430/draft/late-owner/empty/failure/no-writes",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
