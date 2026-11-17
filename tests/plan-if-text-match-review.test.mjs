import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePlanCondition,
  evaluatePlanCondition,
} from "../src/plan-condition.mjs";
import { snapshotPlan, runPlan } from "../src/core.mjs";
const literal = (literal) => ({ literal });
const runtime = (name) => ({ scope: "runtime", name });
const row = (name) => ({ scope: "iterationData", name });
const c = (op, left, right) => ({ op, left, right });
const gate = (condition) => ({
  id: "gate",
  type: "if",
  condition,
  steps: [{ id: "leaf", request: { url: "http://example.test" } }],
});
const plan = (condition) => ({ steps: [gate(condition)] });

test("negative match rejects same-type invalid pairs and invalid right dynamic operands", () => {
  for (const op of ["contains", "notContains"])
    for (const bad of [
      false,
      0,
      null,
      {},
      [],
      new String("secret"),
      "",
      undefined,
      "\ud800",
    ]) {
      for (const [x, y] of [
        [bad, bad],
        ["text", bad],
        [bad, "text"],
      ])
        assert.throws(() =>
          evaluatePlanCondition(c(op, runtime("x"), runtime("y")), {
            runtime: { x, y },
            hidden: [],
          }),
        );
      assert.throws(() =>
        validatePlanCondition(c(op, runtime("x"), literal(bad))),
      );
    }
});

test("text byte boundary is unchanged and old comparisons retain their domains", () => {
  const boundary = "你".repeat(2730) + "ab";
  assert.equal(Buffer.byteLength(boundary), 8192);
  assert.equal(
    evaluatePlanCondition(c("contains", literal(boundary), literal("ab")), {}),
    true,
  );
  assert.throws(() =>
    validatePlanCondition(
      c("notContains", literal(boundary + "x"), literal("absent")),
    ),
  );
  for (const op of ["eq", "neq"])
    assert.throws(() => validatePlanCondition(c(op, literal(""), literal(""))));
  for (const op of ["gt", "gte", "lt", "lte"])
    assert.throws(() =>
      validatePlanCondition(c(op, literal("2"), runtime("x"))),
    );
  assert.equal(
    evaluatePlanCondition(c("eq", literal(false), literal(false)), {}),
    true,
  );
});

test("right-hand row and paired rows are preflighted before any effect", async () => {
  for (const op of ["contains", "notContains"])
    for (const cond of [
      c(op, runtime("x"), row("bad")),
      c(op, row("good"), row("bad")),
    ]) {
      const p = {
        steps: [
          { id: "first", request: { url: "http://example.test" } },
          {
            id: "rows",
            type: "repeat",
            count: 2,
            rows: [
              { good: "secret", bad: "valid" },
              { good: "secret", bad: 4 },
            ],
            steps: [gate(cond)],
          },
        ],
      };
      let hits = 0;
      await assert.rejects(
        runPlan(p, {}, async () => {
          hits++;
          return { status: 200, body: "ok", headers: {} };
        }),
        /文本包含|类型不匹配/,
      );
      assert.equal(hits, 0);
    }
});

test("runtime negative match type failure stops and does not disclose compared values", async () => {
  let hits = 0;
  const secret = "SENSITIVE-TEXT-MARKER";
  const p = snapshotPlan(plan(c("notContains", runtime("x"), runtime("y"))));
  const result = await runPlan(
    p,
    {},
    async () => {
      hits++;
      return { status: 200, body: "ok", headers: {} };
    },
    { variableScopes: { runtime: { x: secret, y: 7 } } },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "condition-error");
  assert.equal(result.conditionResults[0].code, "PLAN_CONDITION_INVALID");
  assert.equal(hits, 0);
  assert(!JSON.stringify(result.conditionResults).includes(secret));
  assert.equal(Object.hasOwn(result.conditionResults[0], "matched"), false);
});
