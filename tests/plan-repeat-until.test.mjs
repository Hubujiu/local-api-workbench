import test from "node:test";
import assert from "node:assert/strict";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { planOccurrences, hasPlanConditions } from "../src/plan-repeat.mjs";
import { conditionSummary } from "../src/execution-history.mjs";
const literal = (value) => ({ literal: value });
const stopAt = (value) => ({
  op: "eq",
  left: { scope: "environment", name: "n" },
  right: literal(value),
});
const leaf = (id = "leaf") => ({
  id,
  request: {
    url: "http://example.test",
    afterScript: "pm.environment.set('n', pm.environment.get('n') + 1);",
  },
});
const loop = (more = {}) => ({
  type: "repeat",
  id: "loop",
  count: 3,
  untilCondition: stopAt(2),
  steps: [leaf()],
  ...more,
});
const response = async () => ({
  status: 200,
  headers: {},
  body: "ok",
  duration: 0,
});

test("condition runs after each body, early exit skips remaining iterations and preserves evidence", async () => {
  const plan = snapshotPlan({
    steps: [loop(), { id: "tail", request: { url: "http://example.test" } }],
  });
  assert.equal(hasPlanConditions(plan.steps), true);
  const run = await runPlan(plan, { n: 0 }, response);
  assert.equal(run.status, "passed");
  assert.deepEqual(
    run.results.map((x) => x.stepId),
    ["leaf", "leaf", "tail"],
  );
  assert.deepEqual(
    run.conditionResults.map((x) => x.matched),
    [false, true],
  );
  assert(
    run.conditionResults.every(
      (x) => x.kind === "repeat-until" && x.phase === "after",
    ),
  );
  assert.equal(
    new Set(run.conditionResults.map((x) => x.occurrenceId)).size,
    2,
  );
  assert.equal(run.snapshot.steps[0].untilCondition.op, "eq");
});

test("last false is a distinct failed exhaustion, not a failed comparison", async () => {
  const plan = snapshotPlan({
    steps: [
      loop({ count: 2, untilCondition: stopAt(5) }),
      { id: "tail", request: { url: "http://example.test" } },
    ],
  });
  const run = await runPlan(plan, { n: 0 }, response);
  assert.equal(run.status, "failed");
  assert.equal(run.stopReason, "repeat-condition-exhausted");
  assert.equal(run.results.length, 2);
  assert.deepEqual(
    run.conditionResults.map((x) => [x.status, x.matched]),
    [
      ["passed", false],
      ["passed", false],
    ],
  );
  assert.equal(run.untilLimit.completedIterations, 2);
  assert.equal(conditionSummary(run).stopReason, "repeat-condition-exhausted");
});

test("count one evaluates after body and body failure stop precedes the condition", async () => {
  const plan = snapshotPlan({
    failurePolicy: "stop",
    steps: [
      loop({
        count: 1,
        untilCondition: stopAt(0),
        steps: [{ id: "bad", request: { url: "http://example.test" } }],
      }),
    ],
  });
  const failed = await runPlan(plan, { n: 0 }, async () => ({
    status: 500,
    headers: {},
    body: "",
    duration: 0,
  }));
  assert.equal(failed.stopReason, "step-failure");
  assert.equal(failed.conditionResults.length, 0);
  const passed = await runPlan(
    snapshotPlan({ steps: [loop({ count: 1, untilCondition: stopAt(1) })] }),
    { n: 0 },
    response,
  );
  assert.equal(passed.status, "passed");
  assert.equal(passed.results.length, 1);
  assert.equal(passed.conditionResults[0].matched, true);
});

test("all disabled body still produces bounded decisions, disabled group produces none", async () => {
  const plan = snapshotPlan({
    steps: [
      loop({
        count: 1,
        untilCondition: { op: "eq", left: literal(true), right: literal(true) },
        steps: [{ ...leaf(), enabled: false }],
      }),
    ],
  });
  const run = await runPlan(plan, {}, response);
  assert.equal(run.status, "passed");
  assert.equal(run.results.length, 0);
  assert.equal(run.conditionResults.length, 1);
  await assert.rejects(
    () =>
      runPlan(
        snapshotPlan({ steps: [loop({ enabled: false })] }),
        {},
        response,
      ),
    /没有可执行/,
  );
});

test("until rejects same-group rows, protocol children, undefined conditions and excessive decisions", () => {
  assert.throws(
    () => snapshotPlan({ steps: [loop({ count: 1, rows: [{}] })] }),
    /同组数据行/,
  );
  assert.throws(
    () => snapshotPlan({ steps: [loop({ untilCondition: undefined })] }),
    /条件/,
  );
  assert.throws(
    () =>
      snapshotPlan({
        steps: [
          loop({
            steps: [
              { id: "wire", type: "protocol", protocol: { definition: {} } },
            ],
          }),
        ],
      }),
    /HTTP/,
  );
  const inner = loop({ id: "inner", count: 3 });
  assert.throws(
    () =>
      snapshotPlan({
        steps: [{ type: "repeat", id: "outer", count: 100, steps: [inner] }],
      }),
    /200/,
  );
});

test("old repeat snapshots and occurrence identities are untouched", () => {
  const old = snapshotPlan({
    steps: [{ type: "repeat", id: "loop", count: 2, steps: [leaf()] }],
  });
  assert.equal(hasPlanConditions(old.steps), false);
  assert(!Object.hasOwn(old.steps[0], "untilCondition"));
  assert.deepEqual(
    planOccurrences(old.steps).map((x) => x.repeat.occurrenceId),
    ['["loop","leaf",0]', '["loop","leaf",1]'],
  );
});

test("nested repeat-until exits only its current group instance", async () => {
  const always = { op: "eq", left: literal(true), right: literal(true) };
  const never = { op: "eq", left: literal(true), right: literal(false) };
  const inner = loop({
    id: "inner",
    count: 3,
    untilCondition: always,
    steps: [{ id: "inside", request: { url: "http://example.test" } }],
  });
  const plan = snapshotPlan({
    steps: [
      {
        type: "repeat",
        id: "outer",
        count: 2,
        steps: [
          inner,
          { id: "after-inner", request: { url: "http://example.test" } },
        ],
      },
    ],
  });
  const run = await runPlan(plan, {}, response);
  assert.equal(run.status, "passed");
  assert.deepEqual(
    run.results.map((x) => x.stepId),
    ["inside", "after-inner", "inside", "after-inner"],
  );
  assert.equal(
    new Set(run.conditionResults.map((x) => x.occurrenceId)).size,
    2,
  );
  const conditionFalse = {
    type: "if",
    id: "if",
    condition: never,
    steps: [{ id: "never", request: { url: "http://example.test" } }],
  };
  const second = snapshotPlan({
    steps: [
      loop({ count: 1, untilCondition: always, steps: [conditionFalse] }),
    ],
  });
  const decisionRun = await runPlan(second, {}, response);
  assert.equal(decisionRun.status, "passed");
  assert.deepEqual(
    decisionRun.conditionResults.map((x) => x.matched),
    [false, true],
  );
  assert.equal(decisionRun.results.length, 0);
});

test("data row from an outer repeat remains visible to its nested until condition", async () => {
  const data = {
    type: "repeat",
    id: "rows",
    count: 2,
    rows: [{ ok: true }, { ok: true }],
    steps: [
      loop({
        id: "inner",
        count: 2,
        untilCondition: {
          op: "eq",
          left: { scope: "iterationData", name: "ok" },
          right: literal(true),
        },
      }),
    ],
  };
  const run = await runPlan(
    snapshotPlan({ steps: [data] }),
    { n: 0 },
    response,
  );
  assert.equal(run.status, "passed");
  assert.equal(run.results.length, 2);
  assert.deepEqual(
    run.conditionResults.map((x) => x.matched),
    [true, true],
  );
});

test("cancelling between false decision and next body preserves completed evidence", async () => {
  const plan = snapshotPlan({
    steps: [loop({ intervalMs: 1000, untilCondition: stopAt(9) })],
  });
  const controller = new AbortController();
  let calls = 0;
  const run = await runPlan(
    plan,
    { n: 0 },
    async () => {
      calls++;
      return response();
    },
    {
      signal: controller.signal,
      onStep: () => setTimeout(() => controller.abort(), 25),
    },
  );
  assert.equal(run.status, "cancelled");
  assert.equal(calls, 1);
  assert.equal(run.results.length, 1);
  assert.deepEqual(
    run.conditionResults.map((item) => item.matched),
    [false],
  );
  assert.equal(run.stopReason, undefined);
});
