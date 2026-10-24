import test from "node:test";
import assert from "node:assert/strict";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { renderPlans } from "../public/plan-view.js";

test("pre-script assertions remain observable on failure and subsequent steps continue", async () => {
  let sends = 0;
  const plan = snapshotPlan({
    steps: [
      {
        name: "blocked",
        request: {
          url: "http://localhost",
          beforeScript:
            'pm.test("required token",()=>pm.expect(false).to.equal(true));console.log("before failure");',
        },
      },
      {
        name: "next",
        request: {
          url: "http://localhost",
          beforeScript: 'pm.test("ready",()=>{});',
          assertions: [{ target: "status", op: "eq", value: 200 }],
          afterScript: 'pm.test("after",()=>{});',
        },
      },
    ],
  });
  const run = await runPlan(plan, {}, async () => {
    sends++;
    return { status: 200, body: "{}", headers: {} };
  });
  assert.equal(sends, 1);
  assert.equal(run.status, "failed");
  assert.equal(run.results[0].requestUnresolved, true);
  assert.equal(run.results[0].assertions[0].name, "required token");
  assert.equal(run.results[0].assertions[0].passed, false);
  assert.equal(run.results[0].assertions[0].phase, "before");
  assert.equal(run.results[0].logs[0].message, "before failure");
  assert.equal(run.results[1].status, "passed");
  assert.deepEqual(
    run.results[1].assertions.map((a) => a.phase),
    ["before", "response", "after"],
  );
});
test("run evidence opens failed steps and safely groups untrusted request response assertion details", () => {
  const project = {
    plans: [],
    runs: [
      {
        id: "run",
        status: "failed",
        results: [
          {
            name: "<img src=x onerror=1>",
            status: "failed",
            requestUnresolved: true,
            request: { url: "http://localhost" },
            assertions: [
              {
                name: "<script>alert(1)</script>",
                passed: false,
                phase: "before",
                error: "missing",
              },
            ],
            error: "<svg onload=1>",
          },
          {
            name: "ok",
            status: "passed",
            response: { status: 200, duration: 0 },
            assertions: [],
          },
        ],
      },
    ],
  };
  const html = renderPlans({ project, tab: "runs" });
  assert.match(html, /data-run-step="0" open/);
  assert.doesNotMatch(html, /data-run-step="1" open/);
  assert.match(html, /请求配置（未发送）/);
  assert.match(html, /前置 · &lt;script&gt;/);
  assert.match(html, /&lt;svg onload=1&gt;/);
  assert.match(html, /提取变量/);
  assert.match(html, /完整步骤证据 JSON/);
  assert.doesNotMatch(html, /<script>|<img|<svg/);
});
