// Independent browser acceptance: real product child-process restart, not reload.
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { startJourneyServer } from "./helpers/gui-journey-server.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = await mkdtemp(path.join(tmpdir(), "gui-full-journey-"));
const databaseFile = path.join(root, "journey.sqlite");
const hits = [];
const peer = http.createServer((req, res) => {
  hits.push({
    authorization: req.headers.authorization,
    database: req.headers["x-journey-db"],
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ value: "journey-response" }));
});
let server,
  browser,
  context,
  page,
  phase = "startup";
const errors = [];
let failed = false;
const mark = (value) => {
  phase = value;
  console.log("GUI_JOURNEY_STAGE", value);
};
const closedDialog = () => page.locator("#dialog").waitFor({ state: "hidden" });
async function save() {
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        /\/api\/projects\//.test(r.url()) &&
        r.status() === 200,
    ),
    page.locator("#save").click(),
  ]);
  await page
    .locator("#saved-state")
    .getByText("✓ 已保存", { exact: true })
    .waitFor();
}
async function execute() {
  const reply = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/execute"),
  );
  await page.locator("#send:not([disabled])").click();
  const value = await (await reply).json();
  await page.locator("#send:not([disabled])").waitFor();
  return value;
}
async function grant(label) {
  await page.locator('.rail [data-page="settings"]').click();
  await page.locator('[data-page="database"]').click();
  await page.locator("#db-type").selectOption("sqlite");
  await page.locator("#db-path").fill(databaseFile);
  await page.locator("#db-register").click();
  await page.locator("#db-connection-name").fill(label);
  await page.locator("#dialog-save").click();
  await closedDialog();
  await page.locator('.rail [data-page="apis"]').click();
}
async function backup() {
  await page.locator("#export").click();
  await page.locator("#export-format").selectOption("native");
  const pending = page.waitForEvent("download");
  await page.locator("#dialog-save").click();
  const value = JSON.parse(
    await readFile(await (await pending).path(), "utf8"),
  );
  await closedDialog();
  return value;
}
async function inspectHistory(expected, label) {
  const before = hits.length;
  await page.getByRole("button", { name: "执行计划", exact: false }).click();
  await page.locator('[data-plan-tab="runs"]').click();
  const exportButton = page.locator(`[data-export-run="${expected.id}"]`);
  const card = page.locator("details.card").filter({ has: exportButton });
  const summary = card.locator(":scope > summary");
  await summary.waitFor({ state: "visible" });
  assert.match(await summary.innerText(), /✓ 通过/);
  assert.ok((await summary.innerText()).includes(expected.planName));
  if ((await card.getAttribute("open")) === null) await summary.click();
  await card
    .getByText(`快照 SHA256: ${expected.planHash}`, { exact: true })
    .waitFor();
  const step = card.locator('[data-run-step="0"] > summary');
  assert.match(await step.innerText(), /passed/);
  assert.match(await step.innerText(), /200/);
  const download = page.waitForEvent("download");
  await exportButton.click();
  const evidence = JSON.parse(
    await readFile(await (await download).path(), "utf8"),
  );
  assert.deepEqual(
    evidence,
    expected,
    "history UI export must preserve original evidence",
  );
  assert.equal(
    hits.length,
    before,
    "viewing history must not replay network activity",
  );
  await page.screenshot({
    path: `/tmp/local-api-restart-${label}-history.png`,
  });
  await page.locator('.rail [data-page="apis"]').click();
}
try {
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec(
      "CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('journey-db')",
    );
  } finally {
    database.close();
  }
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    peer.once("error", onError);
    peer.listen(0, "127.0.0.1", () => {
      peer.off("error", onError);
      resolve();
    });
  });
  server = await startJourneyServer(root);
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_BUNDLED
      ? undefined
      : process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
  });
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(server.launchUrl);
  await page.locator("#new-project").click();
  await page.locator("#new-name").fill("Complete restart journey");
  await page.locator("#dialog-save").click();
  await closedDialog();
  const originalId = await page.locator("#project-select").inputValue();
  mark("import");
  await page.locator("#import").click();
  await page.locator("#import-text").fill(
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Journey", version: "1" },
      servers: [{ url: `http://127.0.0.1:${peer.address().port}` }],
      paths: {
        "/journey": {
          get: {
            summary: "Journey request",
            responses: { 200: { description: "ok" } },
          },
        },
      },
    }),
  );
  await page.locator("#dialog-save").click();
  await closedDialog();
  await page
    .getByRole("button", { name: "GET Journey request", exact: false })
    .click();
  await page.locator('[data-param="auth"]').click();
  await page.locator("#auth-type").selectOption("bearer");
  await page.locator('[data-auth="token"]').fill("fictional-journey-token");
  await page.locator('[data-param="after"]').click();
  await page
    .locator("#script-code")
    .fill(
      'pm.test("journey response",()=>pm.expect(pm.response.json().value).to.equal("journey-response"));',
    );
  await save();
  mark("execute");
  let result = await execute();
  assert.equal(result.outcome, "passed");
  assert.ok(
    result.assertions.some((a) => a.name === "journey response" && a.passed),
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].authorization, "Bearer fictional-journey-token");
  mark("authorize-database");
  await grant("Journey first grant");
  await page.locator('[data-param="before"]').click();
  await page.locator("#add-db-operation").click();
  await page.locator("#operation-db-sql").fill("SELECT value FROM fixture");
  await page.locator("#operation-db-path").fill("$.rows[0].value");
  await page.locator("#dialog-save").click();
  await closedDialog();
  await page
    .locator("#script-code")
    .fill('apt.setRequestHeader("X-Journey-DB", apt.getVar("dbResult"));');
  await save();
  result = await execute();
  assert.equal(result.outcome, "passed");
  assert.equal(result.extracted.dbResult, "journey-db");
  assert.equal(hits.length, 2);
  assert.equal(hits[1].database, "journey-db");
  mark("plan");
  await page.getByRole("button", { name: "执行计划", exact: false }).click();
  await page.locator("#new-plan").click();
  await page.locator("#plan-name").fill("Journey frozen plan");
  await page.locator("#dialog-save").click();
  await closedDialog();
  const pendingRun = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/run"),
  );
  await page
    .getByRole("button", { name: "执行计划", exact: true })
    .last()
    .click();
  const run = await (await pendingRun).json();
  assert.equal(run.status, "passed");
  assert.equal(run.results.length, 1);
  assert.equal(hits.length, 3);
  await page.getByText("✓ 通过", { exact: false }).waitFor();
  await page.locator('.rail [data-page="apis"]').click();
  mark("backup");
  const saved = await backup();
  assert.equal(saved.id, originalId);
  assert.equal(saved.plans.length, 1);
  assert.ok(saved.runs.some((r) => r.id === run.id));
  const request = saved.requests.find((r) => r.name === "Journey request");
  assert.ok(request);
  const oldConnection = request.before.find(
    (x) => x.type === "database",
  ).connectionId;
  assert.ok(oldConnection);
  const first = server;
  mark("restart");
  await page.goto("about:blank");
  await first.close();
  server = null;
  await assert.rejects(fetch(first.url + "/api/session"));
  server = await startJourneyServer(root);
  assert.notEqual(server.pid, first.pid);
  assert.notEqual(
    server.launchUrl.split("#token=")[1],
    first.launchUrl.split("#token=")[1],
  );
  await page.goto(server.launchUrl);
  await page.locator("#project-select").selectOption(originalId);
  mark("history-after-restart");
  await inspectHistory(
    saved.runs.find((r) => r.id === run.id),
    "original",
  );
  await page.locator(`[data-request="${request.id}"]`).click();
  const beforeDenied = hits.length;
  result = await execute();
  assert.equal(result.outcome, "failed");
  assert.match(result.error, /失效|未授权/);
  assert.equal(hits.length, beforeDenied);
  mark("restore");
  await page.locator("#import").click();
  await page.locator("#import-mode").selectOption("restore");
  await page.locator("#import-text").fill(JSON.stringify(saved));
  await page.locator("#dialog-save").click();
  await closedDialog();
  const restoredId = await page.locator("#project-select").inputValue();
  assert.notEqual(restoredId, originalId);
  mark("history-after-restore");
  await inspectHistory(
    saved.runs.find((r) => r.id === run.id),
    "restored",
  );
  assert.equal(hits.length, 3);
  await page
    .getByRole("button", { name: "GET Journey request", exact: false })
    .click();
  result = await execute();
  assert.equal(result.outcome, "failed");
  assert.match(result.error, /失效|未授权/);
  assert.equal(hits.length, 3);
  mark("regrant-and-rebind");
  await grant("Journey replacement grant");
  await page.locator('[data-param="before"]').click();
  await page.locator('[data-edit-db-operation="0"]').click();
  await page.locator("#dialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#operation-db-connection").inputValue(), "");
  await page
    .locator("#operation-db-connection")
    .selectOption({ label: "Journey replacement grant · sqlite" });
  await page.locator("#dialog-save").click();
  await closedDialog();
  await save();
  mark("execute-after-restart");
  result = await execute();
  assert.equal(result.outcome, "passed");
  assert.equal(result.extracted.dbResult, "journey-db");
  assert.ok(
    result.assertions.some((a) => a.name === "journey response" && a.passed),
  );
  assert.equal(hits.length, 4);
  assert.deepEqual(hits[3], {
    authorization: "Bearer fictional-journey-token",
    database: "journey-db",
  });
  const restored = await backup();
  assert.ok(restored.runs.some((r) => r.id === run.id));
  assert.deepEqual(
    restored.plans,
    saved.plans,
    "rebinding live request must not rewrite frozen plans",
  );
  assert.notEqual(
    restored.requests
      .find((r) => r.name === "Journey request")
      .before.find((x) => x.type === "database").connectionId,
    oldConnection,
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "/tmp/local-api-restart-journey.png" });
  console.log("GUI_RESTART_JOURNEY_PASS");
} catch (error) {
  failed = true;
  console.error("GUI_RESTART_JOURNEY_FAILED", phase);
  throw error;
} finally {
  // Every cleanup runs even if trace finalization or browser shutdown rejects.
  const cleanupErrors = [];
  for (const cleanup of [
    () =>
      context?.tracing.stop({
        path: "/tmp/local-api-restart-journey-trace.zip",
      }),
    () => browser?.close(),
    () => server?.close(),
    async () => {
      if (!peer.listening) return;
      peer.closeAllConnections();
      await new Promise((resolve, reject) =>
        peer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  ]) {
    try {
      await cleanup();
    } catch {
      cleanupErrors.push(Error("Journey cleanup failed"));
    }
  }
  // Preserve the isolated root if shutdown could not be verified.
  if (!cleanupErrors.length) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      cleanupErrors.push(Error("Journey root cleanup failed"));
    }
  }
  if (cleanupErrors.length) {
    console.error("GUI_RESTART_JOURNEY_CLEANUP_FAILED", cleanupErrors.length);
    if (!failed)
      throw new AggregateError(cleanupErrors, "Journey cleanup failed");
  }
}
