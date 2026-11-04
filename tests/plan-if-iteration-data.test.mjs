import test from "node:test";
import assert from "node:assert/strict";
import { runPlan, snapshotPlan } from "../src/core.mjs";
import { planOccurrences } from "../src/plan-repeat.mjs";

const leaf = { id: "request", request: { url: "http://example.test/" } };
const condition = {
  op: "eq",
  left: { scope: "iterationData", name: "enabled" },
  right: { literal: true },
};
const gate = (overrides = {}) => ({
  type: "if",
  id: "gate",
  condition,
  steps: [leaf],
  ...overrides,
});
const makePlan = (rows, children = [gate()]) =>
  snapshotPlan({
    steps: [
      { type: "repeat", id: "rows", count: rows.length, rows, steps: children },
    ],
  });
const response = async () => ({
  status: 200,
  headers: {},
  body: "ok",
  duration: 0,
});

test("IF reads only the current row and does not publish it to variables or evidence", async () => {
  const plan = makePlan([
    { enabled: true },
    { enabled: false },
    { enabled: true },
  ]);
  let hits = 0;
  const result = await runPlan(
    plan,
    { enabled: false },
    async () => {
      hits++;
      return response();
    },
    { variableScopes: { runtime: { enabled: false }, hidden: ["enabled"] } },
  );
  assert.equal(result.status, "passed");
  assert.equal(hits, 2);
  assert.deepEqual(
    result.conditionResults.map((x) => x.matched),
    [true, false, true],
  );
  assert.equal(result.results.length, 2);
  assert(!JSON.stringify(result.conditionResults).includes('"enabled"'));
  assert.equal(result.variables.enabled, undefined);
});

test("rows flow into nested ordinary repeats and remain outside runtime scopes", async () => {
  const plan = makePlan(
    [{ enabled: true }, { enabled: false }],
    [{ type: "repeat", id: "inner", count: 2, intervalMs: 1, steps: [gate()] }],
  );
  const controls = planOccurrences(plan.steps, { controls: true }).filter(
    (x) => x.condition,
  );
  assert.deepEqual(
    controls.map((x) => x.dataContext.iterationData.enabled),
    [true, true, false, false],
  );
  let hits = 0;
  const result = await runPlan(plan, {}, async () => {
    hits++;
    return response();
  });
  assert.equal(hits, 2);
  assert.deepEqual(
    result.conditionResults.map((x) => x.matched),
    [true, true, false, false],
  );
});

test("all rows and disabled branches are checked before execution", () => {
  assert.throws(() => snapshotPlan({ steps: [gate()] }), /数据行循环/);
  assert.throws(() => makePlan([{ enabled: true }, {}]), /字段不存在/);
  assert.throws(
    () => makePlan([{ enabled: true }, { enabled: { nested: 1 } }]),
    /比较值/,
  );
  assert.throws(
    () =>
      makePlan(
        [{ enabled: true }, { enabled: "wrong" }],
        [gate({ enabled: false })],
      ),
    /类型不匹配/,
  );
  const gt = { ...condition, op: "gt", right: { literal: 1 } };
  assert.throws(
    () =>
      makePlan([{ enabled: 2 }, { enabled: false }], [gate({ condition: gt })]),
    /顺序比较|类型不匹配/,
  );
});

test("existing conditions and graphs have unchanged snapshots and decisions", async () => {
  const p = snapshotPlan({
    steps: [
      gate({
        condition: {
          op: "eq",
          left: { scope: "runtime", name: "x" },
          right: { literal: 1 },
        },
      }),
    ],
  });
  const saved = JSON.stringify(p);
  const result = await runPlan(p, {}, response, {
    variableScopes: { runtime: { x: 1 } },
  });
  assert.equal(result.status, "passed");
  assert.equal(JSON.stringify(p), saved);
});
