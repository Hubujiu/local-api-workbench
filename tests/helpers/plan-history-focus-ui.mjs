import assert from "node:assert/strict";
import {
  holdRealResponse,
  releaseWithResponse,
  finishHeldRoute,
} from "./execution-write-ownership-ui.mjs";
export async function exercisePlanHistoryFocus(page, endpoint, recordId) {
  const held = holdRealResponse();
  let primary;
  const completed = await page.evaluate(() => window.__planRefreshCompleted);
  await page.route(endpoint, held.handler);
  try {
    await page.locator("#refresh-plan-history").click();
    await held.ready();
    const control = page.locator("[data-export-run]").filter({ visible: true });
    // One existing fixture record. Focus the real reachable export control
    // while GET is held; the completion must not drop focus to document.body.
    assert.equal(await control.count(), 1);
    await control.focus();
    assert.equal(
      await control.evaluate((el) => document.activeElement === el),
      true,
    );
    const response = page.waitForResponse(
      (r) => r.url() === endpoint && r.request().method() === "GET",
    );
    await releaseWithResponse(held, response);
    await page.waitForFunction(
      (n) => window.__planRefreshCompleted === n + 1,
      completed,
    );
    assert.deepEqual(
      await page.evaluate(() => ({
        id: document.activeElement?.dataset.exportRun,
        open: document.activeElement?.closest("details")?.open,
      })),
      { id: recordId, open: true },
    );
    assert.equal(await page.locator("#refresh-plan-history").isEnabled(), true);
    console.log(
      "PLAN_HISTORY_REFRESH_FOCUS_BROWSER_PASS",
      "stable-export-focus/record-open",
    );
  } catch (error) {
    primary = error;
  }
  await finishHeldRoute(
    held,
    () => page.unroute(endpoint, held.handler),
    primary,
  );
}
