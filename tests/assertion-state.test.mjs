import test from "node:test";
import assert from "node:assert/strict";
import { assertionCounts, assertionState } from "../public/assertion-state.js";
import { renderPlans } from "../public/plan-view.js";
test("skips remain distinct from passes, and a contradictory failure is never hidden", () => {
  assert.deepEqual(
    assertionCounts([
      { passed: true },
      { passed: false },
      { passed: true, skipped: true },
      { passed: false, skipped: true },
    ]),
    { passed: 1, failed: 2, skipped: 1 },
  );
  assert.equal(assertionState({ passed: false, skipped: true }), "failed");
  const html = renderPlans({
    project: {
      plans: [],
      runs: [
        {
          id: "r",
          status: "passed",
          results: [
            {
              name: "step",
              status: "passed",
              assertions: [
                { name: "<skip>", passed: true, skipped: true, phase: "after" },
              ],
            },
          ],
        },
      ],
    },
    tab: "runs",
  });
  assert.match(html, /class="muted">跳过 · 后置 · &lt;skip&gt;/);
  assert(!html.includes("✓ 后置 · &lt;skip&gt;"));
});
