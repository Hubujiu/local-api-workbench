import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";

const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_PACKAGE || "playwright",
);
const evidence = process.env.LOAD_WORKSPACE_EVIDENCE;
const root = await mkdtemp("/tmp/workbench-load-workspace-");
const app = await createApp({ root, port: 0 });
let browser;
try {
  const project = await app.store.create("默认项目");
  project.requests = [
    normalizeRequest({
      id: "verification",
      name: "Verification",
      method: "GET",
      url: "http://127.0.0.1:38982/verification",
    }),
  ];
  await app.store.save(project);
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
    blocked.push(request.method() + " " + url.pathname);
    return route.abort();
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const capture = (state) =>
    evidence &&
    page.screenshot({
      path: join(evidence, "load-workbench-" + state + ".png"),
      clip: { x: 0, y: 0, width: 1363, height: 980 },
      caret: "hide",
      animations: "disabled",
    });
  const enter = () =>
    page.getByRole("button", { name: "一键压测", exact: true }).press("Enter");
  await page.goto(app.launchUrl);
  await enter();
  const setup = page.getByRole("region", { name: "一键压测", exact: true });
  const start = setup.getByRole("button", { name: "开始压测", exact: true });
  const result = setup.getByRole("region", { name: "压测结果" });
  const concurrency = setup.locator("#load-concurrency");
  const count = setup.locator("#load-count");
  const duration = setup.locator("#load-duration");
  const mode = setup.locator("#load-mode");
  const file = setup.locator("#load-data-file");
  const csv = setup.locator("#load-data");
  await result.getByText("暂无压测结果", { exact: true }).waitFor();
  assert(await start.isEnabled());
  assert.equal(await mode.inputValue(), "count");
  assert.equal(await concurrency.inputValue(), "1");
  assert.equal(await count.inputValue(), "10");
  await count.fill("1");
  await count.blur();
  await capture("count-idle");
  const metrics = await setup.evaluate((region) => {
    const rect = (selector) => {
      const { x, y, width, height } = region
        .querySelector(selector)
        .getBoundingClientRect();
      return [x, y, width, height].map(Math.round);
    };
    return {
      heading: rect(".load-setup-heading"),
      setup: rect(".load-setup"),
      content: rect(".load-setup-content"),
      csv: rect(".load-data-panel"),
      actions: rect(".load-setup-actions"),
      concurrency: rect("#load-concurrency"),
      mode: rect("#load-mode"),
      results: rect(".load-results"),
    };
  });
  console.log("LOAD_SETUP_BOUNDS", JSON.stringify(metrics));
  assert.deepEqual(metrics.heading.slice(0, 2), [371, 178]);
  assert.equal(metrics.heading[3], 43);
  assert.deepEqual(metrics.concurrency, [699, 284, 120, 34]);
  assert.equal(metrics.mode[0], 699);
  assert.deepEqual(metrics.results.slice(0, 2), [355, 582]);
  assert.equal(await result.locator(".grid-stats").count(), 0);
  await mode.selectOption("duration");
  await duration.fill("60");
  await duration.blur();
  assert.equal(await duration.getAttribute("max"), "60");
  assert.equal(await count.getAttribute("max"), "100");
  assert.equal(await concurrency.getAttribute("max"), "10");
  await capture("duration-idle");

  const local = "fixture\nneutral";
  await file.setInputFiles({
    name: "fixture.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(local),
  });
  await page.waitForFunction(
    (value) => document.querySelector("#load-data")?.value === value,
    local,
  );
  await page.getByRole("button", { name: "调试", exact: true }).press("Enter");
  await enter();
  assert.deepEqual(
    await Promise.all([
      mode.inputValue(),
      duration.inputValue(),
      count.inputValue(),
      csv.inputValue(),
    ]),
    ["duration", "60", "1", local],
  );
  assert((await csv.boundingBox()).width >= 500);
  const details = setup.locator(".load-safety");
  await details.locator("summary").press("Enter");
  assert(await details.getByText(/仅对你有权测试的接口使用/).isVisible());
  await details.locator("summary").press("Enter");
  await page.setViewportSize({ width: 430, height: 760 });
  await file.press("Tab");
  assert(
    await concurrency.evaluate(
      (element) => element.ownerDocument.activeElement === element,
    ),
  );
  await concurrency.press("ArrowUp");
  assert.equal(await concurrency.inputValue(), "2");
  assert.equal(await csv.inputValue(), local);
  const narrow = await setup.boundingBox();
  assert(narrow.x >= 0 && narrow.width > 220 && narrow.x + narrow.width <= 430);
  assert.equal(
    await setup.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
    0,
  );
  assert(await result.getByText("暂无压测结果").isVisible());
  const after = await app.store.get(project.id);
  assert.equal(after.configRevision, before.configRevision);
  assert.deepEqual(after.requests, before.requests);
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
  console.log(
    "LOAD_WORKSPACE_PASS idle/count/duration/real-local-CSV/keyboard/narrow/no-writes-or-runs",
  );
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
