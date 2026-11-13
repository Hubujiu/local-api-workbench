import assert from "node:assert/strict";
import { assertRestartedProject } from "./restart-project-receipt.mjs";
import { readFile } from "node:fs/promises";
// Shared UI actions/assertions for Chromium-service and packaged Electron hosts.
export async function exerciseRestartJourney({
  initialPage,
  restart,
  databaseFile,
  hits,
  peerURL,
  screenshotPath,
  mark,
}) {
  let page = initialPage;
  const closedDialog = () =>
    page.locator("#dialog").waitFor({ state: "hidden" });
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
    await page.locator('header button[data-page="plans"]').click();
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
      path: screenshotPath(`${label}-history.png`),
    });
    await page.locator('.rail [data-page="apis"]').click();
  }
  await page.locator("#new-project").click();
  await page.locator("#new-name").fill("Complete restart journey");
  await page.locator("#dialog-save").click();
  await closedDialog();
  const originalId = await page.locator("#project-select").inputValue();
  mark("invalid-import-recovery");
  const readPersisted = () =>
    page.evaluate(async (id) => {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(id)}/export?format=native`,
        {
          headers: {
            "x-local-token": sessionStorage.getItem("local-api-token"),
          },
        },
      );
      if (!response.ok)
        throw Error(`Import readback failed: ${response.status}`);
      return response.json();
    }, originalId);
  const beforeInvalid = await readPersisted();
  const hitsBeforeInvalid = hits.length;
  await page.locator("#import").click();
  await page.locator("#import-text").fill('{"openapi":');
  const invalidReply = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/projects/${originalId}/import`),
  );
  await page.locator("#dialog-save").click();
  const rejectedImport = await invalidReply;
  assert.equal(rejectedImport.status(), 400);
  await page.locator("#dialog-save:not([disabled])").waitFor();
  assert.equal(await page.locator("#dialog").evaluate((d) => d.open), true);
  assert.equal(await page.locator("#import-text").inputValue(), '{"openapi":');
  assert.equal(await page.locator("#project-select").inputValue(), originalId);
  assert.deepEqual(
    await readPersisted(),
    beforeInvalid,
    "Rejected import must not mutate the original persisted project",
  );
  assert.equal(
    hits.length,
    hitsBeforeInvalid,
    "Rejected import must not execute business traffic",
  );
  mark("import");
  // A POST failure remains conservatively gated until an explicit safe GET.
  // Do not infer a reusable no-write receipt from HTTP 400 alone.
  assert.match(await page.locator("#toast").textContent(), /重新加载核对/);
  await page.keyboard.press("Escape");
  await closedDialog();
  await page.locator('.rail [data-page="history"]').click();
  const reloaded = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" &&
      r.url().endsWith(`/projects/${originalId}`) &&
      r.status() === 200,
  );
  await page.locator("#history-project-reload").click();
  await reloaded;
  await page.locator("#history-project-reload:not([disabled])").waitFor();
  assert.deepEqual(await readPersisted(), beforeInvalid);
  assert.equal(hits.length, hitsBeforeInvalid);
  await page.locator('.rail [data-page="apis"]').click();
  await page.locator("#import").click();
  // Explicitly import the corrected document only after reconciliation.

  await page.locator("#import-text").fill(
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Journey", version: "1" },
      servers: [{ url: peerURL }],
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
    .locator(".sidebar button[data-request]")
    .filter({ hasText: /^GET\s*Journey request$/ })
    .click();
  console.log("FIRST_USE_INVALID_IMPORT_RECOVERY_PASS");
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
  await page.locator('header button[data-page="plans"]').click();
  await page.locator("#new-plan").click();
  await page.locator("#plan-name").fill("Journey frozen plan");
  await page.locator("#dialog-save").click();
  await closedDialog();
  const pendingRun = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/run"),
  );
  await page.locator("#run-plan").click();
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
  mark("restart");
  page = await restart();
  const oldProjectSelect = await page
    .locator("#project-select")
    .elementHandle();
  assert.ok(oldProjectSelect);
  try {
    await page.locator("#project-select").selectOption(originalId);
    await page.waitForFunction(
      (element) => !element.isConnected,
      oldProjectSelect,
    );
    assert.equal(
      await page.locator("#project-select").inputValue(),
      originalId,
    );
  } finally {
    await oldProjectSelect.dispose();
  }
  // Read the original persisted project before any save, execute or external
  // backup restore can mask loss. The UI export action saves first, so use its
  // read-only export endpoint directly for this observation.
  const restarted = await page.evaluate(async (id) => {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(id)}/export?format=native`,
      {
        headers: { "x-local-token": sessionStorage.getItem("local-api-token") },
      },
    );
    if (!response.ok)
      throw Error(`Restart readback failed: ${response.status}`);
    return response.json();
  }, originalId);
  assertRestartedProject(saved, restarted);
  mark("original-persisted-project-verified");
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
    .locator(".sidebar button[data-request]")
    .filter({ hasText: /^GET\s*Journey request$/ })
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
  await page.screenshot({ path: screenshotPath("journey.png") });
}
