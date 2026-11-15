import assert from "node:assert/strict";
import {
  holdRealResponse,
  releaseWithResponse,
  finishHeldRoute,
} from "./execution-write-ownership-ui.mjs";

// Observe completion of the actual async DOM listener, including after its
// button is detached. No production state or network response is replaced.
export function observeRefreshCompletion() {
  window.__planRefreshCompleted = 0;
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (
      type === "click" &&
      this instanceof HTMLElement &&
      this.id === "refresh-plan-history" &&
      typeof listener === "function"
    ) {
      const original = listener;
      listener = function (event) {
        return Promise.resolve(original.call(this, event)).finally(() => {
          window.__planRefreshCompleted++;
        });
      };
    }
    return add.call(this, type, listener, options);
  };
}

export async function exerciseHeldPlanHistoryRefresh(
  page,
  endpoint,
  recordId,
  requests,
) {
  const before = requests.length;
  const completed = await page.evaluate(() => window.__planRefreshCompleted);
  const held = holdRealResponse();
  let primary;
  await page.route(endpoint, held.handler);
  try {
    await page.locator("#refresh-plan-history").click();
    await held.ready(); // Real upstream GET already returned, response held.
    const button = page.locator("#refresh-plan-history");
    assert.equal(await button.isDisabled(), true);
    // Native click honours disabled; do not force or dispatch a synthetic event.
    await button.evaluate((element) => element.click());
    assert.deepEqual(requests.slice(before), [
      { url: endpoint, method: "GET" },
    ]);
    assert.equal(
      await page.locator(`[data-export-run="${recordId}"]`).count(),
      0,
    );
    const oldRecords = await page.locator("#plan-run-records").elementHandle();
    try {
      await page.locator('[data-plan-tab="plans"]').click();
      assert.equal(await page.locator("#plan-run-records").count(), 0);
      await page.locator('[data-plan-tab="runs"]').click();
      await page.locator("#plan-run-records").waitFor({ state: "visible" });
      assert.equal(
        await oldRecords.evaluate((element) => element.isConnected),
        false,
      );
      // Same owner/page/tab/editVersion, but a new records DOM owns the view.
      const response = page.waitForResponse(
        (r) => r.url() === endpoint && r.request().method() === "GET",
      );
      await releaseWithResponse(held, response);
      await page.waitForFunction(
        (count) => window.__planRefreshCompleted === count + 1,
        completed,
      );
      assert.equal(
        await page.locator(`[data-export-run="${recordId}"]`).count(),
        0,
      );
      // Re-render once more after actual handler settlement to expose any
      // invisible cache adoption, not just a detached DOM write.
      await page.locator('[data-plan-tab="plans"]').click();
      await page.locator('[data-plan-tab="runs"]').click();
      assert.equal(await page.locator("[data-export-run]").count(), 0);
      assert.equal(
        await page.locator("#refresh-plan-history").isEnabled(),
        true,
      );
      await page
        .locator("#saved-state")
        .getByText("● 未保存", { exact: true })
        .waitFor();
      assert.deepEqual(
        requests.slice(before),
        [{ url: endpoint, method: "GET" }],
        "no duplicate refresh or navigation reload",
      );
    } finally {
      await oldRecords.dispose();
    }
  } catch (error) {
    primary = error;
  }
  await finishHeldRoute(
    held,
    () => page.unroute(endpoint, held.handler),
    primary,
  );
  console.log(
    "PLAN_HISTORY_REFRESH_HELD_BROWSER_PASS",
    "real-GET/tab-return/handler-settled/no-hidden-adoption/disabled-no-duplicate",
  );
}
