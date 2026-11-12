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
// Keep the real upstream response held until the test releases it, and join the
// handler before unroute/teardown. Route errors must fail the test, not escape
// as an unhandled rejection that hides its original assertion failure.
export function holdRealResponse() {
  const received = deferred(),
    release = deferred(),
    finished = deferred();
  let started = false,
    failure;
  const handler = async (route) => {
    if (started) {
      failure ||= Error("unexpected duplicate held request");
      await route.abort("failed").catch((error) => {
        failure ||= error;
      });
      return;
    }
    started = true;
    try {
      const response = await route.fetch();
      assert.equal(response.status(), 200, "real upstream request committed");
      received.resolve();
      await release.promise;
      await route.fulfill({ response });
    } catch (error) {
      failure ||= error;
      received.resolve();
    } finally {
      finished.resolve();
    }
  };
  const check = () => {
    if (failure) throw failure;
  };
  return {
    handler,
    async ready() {
      await bounded(received.promise);
      check();
    },
    async release() {
      release.resolve();
      if (started) await bounded(finished.promise);
      check();
    },
  };
}
export async function releaseWithResponse(held, response) {
  // Observe both promises immediately even if release fails before the response.
  await Promise.all([response, held.release()]);
}
export async function finishHeldRoute(held, unroute, primary) {
  const errors = primary ? [primary] : [];
  try {
    await held.release();
  } catch (error) {
    errors.push(error);
  }
  try {
    await unroute();
  } catch (error) {
    errors.push(error);
  }
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(
      unique,
      "execution fixture and route cleanup failed",
    );
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
  const heldSave = holdRealResponse();
  const holdSave = (route) =>
    route.request().method() === "PUT"
      ? heldSave.handler(route)
      : route.continue();
  await page.route(endpoint, holdSave);
  let saveFailure;
  try {
    await page.locator('[data-run-case="' + caseId + '"]').click();
    await heldSave.ready();
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
    await releaseWithResponse(heldSave, done);
    await page.waitForFunction(
      (id) => !document.querySelector('[data-run-case="' + id + '"]')?.disabled,
      caseId,
    );
    assert.equal(
      executions,
      1,
      "double click causes exactly one execution POST",
    );
  } catch (error) {
    saveFailure = error;
  } finally {
    await finishHeldRoute(
      heldSave,
      () => page.unroute(endpoint, holdSave),
      saveFailure,
    );
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
  const heldRun = holdRealResponse(),
    holdRun = heldRun.handler;
  await page.route(endpoint + "/run", holdRun);
  let runFailure;
  try {
    await page.locator("#run-plan").click();
    await heldRun.ready();
    await page.locator("#plan-name").fill("New plan draft after execution");
    await heldRun.release();
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
  } catch (error) {
    runFailure = error;
  } finally {
    await finishHeldRoute(
      heldRun,
      () => page.unroute(endpoint + "/run", holdRun),
      runFailure,
    );
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
