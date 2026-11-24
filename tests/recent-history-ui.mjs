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
const evidence = process.env.RECENT_HISTORY_EVIDENCE;
const root = await mkdtemp(join(tmpdir(), "workbench-recent-history-"));
const app = await createApp({ root, port: 0 });
let browser;
try {
  const project = await app.store.create("默认项目");
  const request = normalizeRequest({
    id: "verification",
    name: "Verification",
    method: "GET",
    url: "http://127.0.0.1:38982/verification",
  });
  project.requests = [request];
  await app.store.save(project);
  const append = (id, name, hour, status, daysAgo = 0) => {
    const createdAt = new Date();
    createdAt.setDate(createdAt.getDate() - daysAgo);
    createdAt.setHours(hour, 30, 0, 0);
    return app.store.append(project.id, "history", {
      id,
      name,
      createdAt: createdAt.toISOString(),
      request: {
        id: request.id,
        url: request.url + "?url-only-diagnostic",
        method: "GET",
      },
      response: { status },
      source: "manual",
    });
  };
  await append("first", "Verification", 7, 200, 1);
  await append("second", "Verification", 10, 201);
  await append("case-label", "新建用例", 20, 204);
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
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin === origin && request.method() === "GET")
      return route.continue();
    blocked.push(request.method());
    return route.abort();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = (state) =>
    evidence &&
    page.screenshot({
      path: join(evidence, "recent-workbench-" + state + ".png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
    });
  await page.goto(app.launchUrl);
  await page.locator('.rail [data-page="history"]').press("Enter");
  const workspace = page.locator(".recent-workspace");
  const http = workspace.getByRole("region", { name: "最近", exact: true });
  const search = http.getByRole("searchbox", { name: "按发送记录名称筛选" });
  const count = http.getByRole("status");
  const timeline = http.locator(".recent-history-timeline");
  const rowNames = () =>
    timeline
      .locator(
        "[data-recent-history-row]:not([hidden]) [data-recent-history-name]",
      )
      .allTextContents();
  const latestRow = timeline.locator('[data-history="second"]');
  const olderRow = timeline.locator('[data-history="first"]');
  const group = timeline
    .locator(".recent-history-day")
    .filter({ has: page.locator('[data-history="second"]') });
  const olderGroup = timeline
    .locator(".recent-history-day")
    .filter({ has: page.locator('[data-history="first"]') });
  await timeline.getByText("今天", { exact: true }).waitFor();
  assert(await page.locator(".shell > .sidebar").isHidden());
  assert.equal(await count.textContent(), "匹配 3 / 3 条记录");
  assert.deepEqual(await rowNames(), [
    "新建用例",
    "Verification",
    "Verification",
  ]);
  assert(await workspace.locator("#protocol-history").isVisible());
  assert(!(await timeline.textContent()).includes("url-only-diagnostic"));
  const metrics = await http.evaluate((panel) => {
    const box = (selector) => {
      const { x, y, width, height } = panel
        .querySelector(selector)
        .getBoundingClientRect();
      return [x, y, width, height].map(Math.round);
    };
    return {
      heading: box("#recent-sent-tab"),
      query: box("#recent-history-query"),
      day: box(".recent-history-day > summary"),
      row: box(".recent-history-row"),
    };
  });
  console.log("RECENT_HTTP_HISTORY_BOUNDS", JSON.stringify(metrics));
  await capture("history");
  assert.deepEqual(metrics.heading.slice(0, 2), [66, 60]);
  assert.deepEqual(metrics.query, [1037, 60, 310, 32]);
  assert.deepEqual(metrics.day, [66, 108, 1281, 36]);
  assert.equal(metrics.row[3], 60);

  // A collapsed matching day must be revealed, not merely counted.
  await group.locator("summary").press("Enter");
  assert(await latestRow.isHidden());
  assert(await olderRow.isVisible());
  await search.fill("Verification");
  assert(await latestRow.isVisible());
  assert(await olderRow.isVisible());
  assert.equal(await count.textContent(), "匹配 2 / 3 条记录");
  assert.deepEqual(await rowNames(), ["Verification", "Verification"]);
  await capture("history-filter");
  await search.fill("新建用例");
  assert(await olderGroup.isHidden());
  assert(await timeline.locator('[data-history="case-label"]').isVisible());
  await search.fill("url-only-diagnostic");
  assert.equal(await count.textContent(), "匹配 0 / 3 条记录");
  assert(
    await http.getByText("暂无符合名称的发送记录", { exact: true }).isVisible(),
  );
  await search.fill("  vErIfIcAtIoN ");
  assert.deepEqual(await rowNames(), ["Verification", "Verification"]);
  assert(await search.evaluate((input) => document.activeElement === input));
  assert(await latestRow.isVisible());
  // Clearing by whitespace restores independently open/collapsed groups.
  await search.fill("   ");
  assert.equal(await count.textContent(), "匹配 3 / 3 条记录");
  assert(await latestRow.isHidden());
  assert(await olderRow.isVisible());
  await group.locator("summary").press("Enter");
  assert(await latestRow.isVisible());
  await search.fill("Verification");
  await search.clear();
  assert(await latestRow.isVisible(), "new search must capture new disclosure");

  await page.setViewportSize({ width: 430, height: 760 });
  await http.locator('[data-history="second"]').press("Enter");
  const detail = page.getByRole("dialog", {
    name: "Verification",
    exact: true,
  });
  const original = JSON.parse(
    await detail.locator("#dialog-content pre").textContent(),
  );
  assert.equal(original.id, "second");
  assert.equal(original.response.status, 201);
  assert(
    await detail.getByRole("button", { name: "导出", exact: true }).isEnabled(),
  );
  await page.keyboard.press("Escape");
  await detail.waitFor({ state: "hidden" });
  assert.equal(
    await workspace.evaluate((panel) => panel.scrollWidth - panel.clientWidth),
    0,
  );
  const reloaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/projects/" + project.id &&
      response.request().method() === "GET",
  );
  await Promise.all([
    reloaded,
    http.locator("#history-project-reload").press("Enter"),
  ]);
  await page.waitForFunction(
    () => document.querySelector("#recent-history-query")?.value === "",
  );
  assert.equal(await count.textContent(), "匹配 3 / 3 条记录");
  const after = await app.store.get(project.id);
  assert.deepEqual(after.history, before.history);
  assert.equal(after.configRevision, before.configRevision);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "RECENT_HTTP_HISTORY_PASS stored/filters/keyboard/detail/reload/protocol/no-mutations",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
