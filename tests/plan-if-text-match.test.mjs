import test from "node:test";
import assert from "node:assert/strict";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import {
  validatePlanCondition,
  evaluatePlanCondition,
} from "../src/plan-condition.mjs";
const literal = (value) => ({ literal: value });
const variable = (name) => ({ scope: "runtime", name });
const row = (name) => ({ scope: "iterationData", name });
const cond = (op, left, right) => ({ op, left, right });
const state = { runtime: { x: "Hello 世界", needle: "世界" }, hidden: [] };

test("text contains is directional, case-sensitive, literal and not normalized", () => {
  for (const [op, left, right, expected] of [
    ["contains", "Hello 世界", "世界", true],
    ["notContains", "Hello 世界", "世界", false],
    ["contains", "Hello", "hello", false],
    ["notContains", "Hello", "hello", true],
    ["contains", "literal .*", ".*", true],
    ["contains", "é", "e\u0301", false],
    ["contains", "needle", "long needle", false],
  ])
    assert.equal(
      evaluatePlanCondition(cond(op, literal(left), literal(right)), state),
      expected,
    );
  assert.equal(
    evaluatePlanCondition(
      cond("contains", variable("x"), variable("needle")),
      state,
    ),
    true,
  );
});

test("invalid text operands never become a successful negative match", () => {
  for (const op of ["contains", "notContains"])
    for (const bad of [
      null,
      true,
      42,
      [],
      {},
      "",
      "\ud800",
      "你".repeat(2731),
    ]) {
      assert.throws(() =>
        validatePlanCondition(cond(op, literal("ok"), literal(bad))),
      );
      assert.throws(() =>
        validatePlanCondition(cond(op, literal(bad), variable("x"))),
      );
      assert.throws(() =>
        evaluatePlanCondition(cond(op, variable("bad"), literal("ok")), {
          runtime: { bad },
          hidden: [],
        }),
      );
    }
});

test("all potential inline row text operands are preflighted, including disabled branches", () => {
  const plan = (values, condition) => ({
    steps: [
      {
        type: "repeat",
        id: "rows",
        count: values.length,
        rows: values.map((v) => ({ value: v })),
        steps: [
          {
            type: "if",
            id: "gate",
            enabled: false,
            condition,
            steps: [{ id: "request", request: { url: "http://example.test" } }],
          },
        ],
      },
    ],
  });
  assert.doesNotThrow(() =>
    snapshotPlan(
      plan(["alpha", "beta"], cond("contains", row("value"), literal("a"))),
    ),
  );
  for (const op of ["contains", "notContains"])
    assert.throws(
      () =>
        snapshotPlan(plan(["alpha", 3], cond(op, row("value"), variable("x")))),
      /文本包含/,
    );
});

test("row/runtime combinations keep scopes separate and skip false descendants", async () => {
  const plan = snapshotPlan({
    steps: [
      {
        type: "repeat",
        id: "rows",
        count: 3,
        rows: [{ word: "alpha" }, { word: "beta" }, { word: "gamma" }],
        steps: [
          {
            type: "if",
            id: "gate",
            condition: cond("contains", row("word"), variable("needle")),
            steps: [{ id: "request", request: { url: "http://example.test" } }],
          },
        ],
      },
    ],
  });
  let calls = 0;
  const run = await runPlan(
    plan,
    {},
    async () => {
      calls++;
      return { status: 200, headers: {}, body: "ok", duration: 0 };
    },
    { variableScopes: { runtime: { needle: "m" } } },
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    run.conditionResults.map((x) => x.matched),
    [false, false, true],
  );
  assert.equal(run.status, "passed");
});
