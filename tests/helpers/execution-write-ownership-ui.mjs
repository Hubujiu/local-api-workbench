import assert from "node:assert/strict";
import { createImportOwnershipFixture } from "./project-import-ownership-ui.mjs";
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("execution fixture timeout")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function exerciseExecutionWriteOwnership(page) {
  await createImportOwnershipFixture(page);
  await page.locator('.rail [data-page="apis"]').click();
  await page.locator("#add-request").click();
  await page.locator("#request-name").fill("Execution source");
  await page.locator("#url").fill("http://127.0.0.1:1/never-called");
  const id = await page.locator("#project-select").inputValue(),
    endpoint = new URL("/api/projects/" + id, page.url()).href;
  async function save() {
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url() === endpoint &&
          r.request().method() === "PUT" &&
          r.status() === 200,
      ),
      page.locator("#save").click(),
    ]);
    await page
      .locator("#saved-state")
      .getByText("✓ 已保存", { exact: true })
      .waitFor();
  }
  await save();
  await page.locator('[data-mode="cases"]').click();
  await page.locator("#new-interface-case").click();
  await page.locator("#case-name").fill("Once only");
  const [created] = await Promise.all([
    page.waitForResponse(
      (r) => r.url() === endpoint + "/cases" && r.status() === 200,
    ),
    page.locator("#dialog-save").click(),
  ]);
  const caseId = (await created.json()).item.id;
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator("#request-name").fill("Dirty execution source");
  let executions = 0,
    planRuns = 0;
  const observe = (request) => {
    if (request.method() === "POST" && request.url() === endpoint + "/execute")
      executions++;
    if (request.method() === "POST" && request.url() === endpoint + "/run")
      planRuns++;
  };
  page.on("request", observe);
  const saved = deferred(),
    releaseSave = deferred();
  const holdSave = async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    saved.resolve();
    await releaseSave.promise;
    await route.fulfill({ response });
  };
  await page.route(endpoint, holdSave);
  try {
    await page.locator('[data-run-case="' + caseId + '"]').click();
    await bounded(saved.promise);
    await page.locator('[data-run-case="' + caseId + '"]').click();
    await page
      .locator("#toast")
      .getByText(/请等待/)
      .waitFor();
    assert.equal(
      executions,
      0,
      "no external execution before the owning save finishes",
    );
    const done = page.waitForResponse(
      (r) =>
        r.url() === endpoint &&
        r.request().method() === "GET" &&
        r.status() === 200,
    );
    releaseSave.resolve();
    await done;
    await page.waitForFunction(
      (id) => !document.querySelector('[data-run-case="' + id + '"]')?.disabled,
      caseId,
    );
    assert.equal(
      executions,
      1,
      "double click causes exactly one execution POST",
    );
  } finally {
    releaseSave.resolve();
    await page.unroute(endpoint, holdSave);
  }
  await page.locator('[data-page="plans"]').click();
  await page.locator("#new-plan").click();
  await page.locator("#plan-name").fill("Owned execution plan");
  const [planResponse] = await Promise.all([
    page.waitForResponse(
      (r) => r.url() === endpoint + "/plans" && r.status() === 200,
    ),
    page.locator("#dialog-save").click(),
  ]);
  const planId = (await planResponse.json()).id;
  await page.locator("#dialog").waitFor({ state: "hidden" });
  await page.locator('[data-plan="' + planId + '"]').click();
  const completed = deferred(),
    releaseRun = deferred();
  const holdRun = async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    completed.resolve();
    await releaseRun.promise;
    await route.fulfill({ response });
  };
  await page.route(endpoint + "/run", holdRun);
  try {
    await page.locator("#run-plan").click();
    await bounded(completed.promise);
    await page.locator("#plan-name").fill("New plan draft after execution");
    releaseRun.resolve();
    await page
      .locator("#toast")
      .getByText(/不会自动重放/)
      .waitFor();
    assert.equal(
      await page.locator("#plan-name").inputValue(),
      "New plan draft after execution",
    );
    await page.locator("#run-plan").click();
    await page
      .locator("#toast")
      .getByText(/重新加载原项目核对执行结果/)
      .waitFor();
    assert.equal(planRuns, 1);
  } finally {
    releaseRun.resolve();
    await page.unroute(endpoint + "/run", holdRun);
  }
  const discard = (dialog) => dialog.accept();
  page.on("dialog", discard);
  try {
    await Promise.all([
      page.waitForResponse(
        (r) => r.url() === endpoint && r.request().method() === "GET",
      ),
      page.locator("#project-select").selectOption(id),
    ]);
    await page.locator('[data-plan="' + planId + '"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector("#plan-name")?.value === "Owned execution plan",
    );
  } finally {
    page.off("dialog", discard);
  }
  // Explicit new execution is permitted after checking the current persisted state.
  await Promise.all([
    page.waitForResponse(
      (r) => r.url() === endpoint + "/run" && r.status() === 200,
    ),
    page.locator("#run-plan").click(),
  ]);
  await page.locator('[data-plan-tab="runs"].primary').waitFor();
  assert.equal(planRuns, 2);
  page.off("request", observe);
  await page.screenshot({
    path: "/tmp/local-api-execution-write-ownership.png",
  });
  console.log("GUI_EXECUTION_WRITE_OWNERSHIP_PASS");
}
