import test from "node:test";
import assert from "node:assert/strict";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import {
  validatePlanCondition,
  evaluatePlanCondition,
  validateConditionScopeInput,
} from "../src/plan-condition.mjs";
import {
  activePlanStepCount,
  planOccurrences,
  REPEAT_EVIDENCE_BYTES,
} from "../src/plan-repeat.mjs";
import { assertNativeLinearResult } from "../src/native-mcp-tools.mjs";
const literal = (value) => ({ literal: value });
const leaf = (id = "leaf") => ({
  id,
  request: { url: "http://127.0.0.1:1/never" },
});
const condition = (left = 1, op = "eq", right = 1) => ({
  left: literal(left),
  op,
  right: literal(right),
});
const group = (id = "if", steps = [leaf()], c = condition()) => ({
  type: "if",
  id,
  condition: c,
  steps,
});
const state = { globals: {}, environment: {}, runtime: {}, hidden: [] };

test("closed IF comparisons accept only the evidenced same-type primitive domain", () => {
  for (const [left, op, right, expected] of [
    [1, "eq", 1, true],
    [1, "neq", 2, true],
    [1, "gt", 2, false],
    [2, "gte", 2, true],
    [1, "lt", 2, true],
    [1, "lte", 1, true],
    [null, "eq", null, true],
    [false, "eq", false, true],
    ["safe", "neq", "other", true],
  ]) {
    assert.equal(
      evaluatePlanCondition(condition(left, op, right), state),
      expected,
    );
  }
  for (const c of [
    condition(1, "==", 1),
    condition(1, "eval", 1),
    condition(1, "eq", "1"),
    condition("", "eq", ""),
    condition({}, "eq", {}),
    condition(NaN),
    condition(Infinity),
    condition("2", "gt", "1"),
    condition("x".repeat(8193)),
    { ...condition(), unknown: true },
  ])
    assert.throws(() => validatePlanCondition(c));
  const both = condition();
  both.left.scope = "runtime";
  both.left.name = "x";
  assert.throws(() => validatePlanCondition(both));
  for (const value of [undefined, false, 0, "", null]) {
    if (value === undefined) {
      validateConditionScopeInput({}, { environment: undefined });
      continue;
    }
    assert.throws(() =>
      validateConditionScopeInput({ secret: 1 }, { environment: value }),
    );
  }
  for (const hidden of ["secret", false, 0, null, [null], ["__proto__"]])
    assert.throws(() => validateConditionScopeInput({}, { hidden }));
});

test("combined IF/repeat depth and leaf/decision/work budgets include disabled and false definitions", () => {
  let steps = [leaf()];
  for (let i = 0; i < 4; i++)
    steps = [
      i % 2
        ? { type: "repeat", id: "r" + i, count: 1, steps }
        : group("i" + i, steps),
    ];
  assert.equal(snapshotPlan({ steps: [group()] }).steps[0].name, "条件组");
  const frozen = snapshotPlan({ steps });
  assert.equal(activePlanStepCount(frozen), 1);
  assert.throws(
    () =>
      snapshotPlan({ steps: [{ ...group("extra", steps), enabled: false }] }),
    /4层|类型/,
  );
  const count = (n) => [
    {
      type: "repeat",
      id: "repeat",
      count: n,
      steps: [group("outer", [group("inner")])],
    },
  ];
  assert.equal(snapshotPlan({ steps: count(100) }).steps[0].count, 100);
  const tooMany = count(100);
  tooMany[0].steps[0].steps = [group("inner", [group("third")])];
  tooMany[0].enabled = false;
  assert.throws(() => snapshotPlan({ steps: tooMany }), /200次/);
  const leafBudget = [
    group(
      "gate",
      [
        {
          type: "repeat",
          id: "outer",
          count: 3,
          steps: [{ type: "repeat", id: "inner", count: 100, steps: [leaf()] }],
        },
      ],
      condition(1, "eq", 2),
    ),
  ];
  assert.throws(() => snapshotPlan({ steps: leafBudget }), /200个/);
  const payload = group("large", [
    {
      ...leaf(),
      request: { url: "http://127.0.0.1:1/", body: "x".repeat(50000) },
    },
  ]);
  assert.throws(
    () =>
      snapshotPlan({
        steps: [
          {
            type: "repeat",
            id: "r",
            count: 100,
            enabled: false,
            steps: [payload],
          },
        ],
      }),
    /4MiB/,
  );
  const invalid = group();
  invalid.steps[0].type = "socketio";
  assert.throws(() => snapshotPlan({ steps: [invalid] }), /HTTP/);
  const disabled = snapshotPlan({
    steps: [{ ...group(), enabled: false }, leaf("tail")],
  });
  assert.deepEqual(
    planOccurrences(disabled.steps, { controls: true }).map((o) => o.step.id),
    ["tail"],
  );
});

test("disabled IF descriptor and nested payload hooks reject without invocation", () => {
  for (const location of ["condition", "left", "literal", "request"]) {
    let hits = 0;
    const g = group();
    g.enabled = false;
    const target =
      location === "condition"
        ? g
        : location === "left"
          ? g.condition
          : location === "literal"
            ? g.condition.left
            : g.steps[0];
    Object.defineProperty(target, location, {
      enumerable: true,
      get() {
        hits++;
        return 1;
      },
    });
    assert.throws(() => snapshotPlan({ steps: [g] }));
    assert.equal(hits, 0);
  }
  for (const location of ["condition", "request"]) {
    let hits = 0;
    const g = group();
    g.enabled = false;
    const proxy = new Proxy(
      {},
      {
        get() {
          hits++;
        },
        ownKeys() {
          hits++;
          return [];
        },
        getPrototypeOf() {
          hits++;
          return Object.prototype;
        },
      },
    );
    if (location === "condition") g.condition = proxy;
    else g.steps[0].request = proxy;
    assert.throws(() => snapshotPlan({ steps: [g] }));
    assert.equal(hits, 0);
  }
});

test("shared evidence quota survives false skips and identifies pending control rather than results index", async () => {
  const plan = snapshotPlan({
    steps: [
      group("false", [leaf("skip")], condition(1, "eq", 2)),
      leaf("large"),
      group("next", [leaf("inside")]),
      leaf("tail"),
    ],
  });
  let calls = 0;
  const result = await runPlan(plan, {}, async (request) => {
    calls++;
    return {
      status: 200,
      headers: {},
      body: "x".repeat(REPEAT_EVIDENCE_BYTES + 1),
      durationMs: 0,
    };
  });
  assert.equal(calls, 1);
  assert.equal(result.stopReason, "evidence-limit");
  assert.equal(result.evidenceBudget.executed, 1);
  assert.equal(result.evidenceBudget.remaining, 2);
  assert.equal(result.evidenceBudget.last.stepId, "large");
  assert.deepEqual(result.evidenceBudget.next, {
    stepId: "next",
    kind: "condition",
    occurrenceId: '["if",[],"next"]',
  });
  assert.equal(result.evidenceBudget.decisions, 1);
  assert.equal(result.conditionResults.length, 1);
});

test("native result projection rejects decision evidence even when the historical snapshot is absent", () => {
  assert.throws(
    () => assertNativeLinearResult({ results: [], conditionResults: [] }),
    /canonical/,
  );
  assert.throws(
    () =>
      assertNativeLinearResult({
        snapshot: null,
        results: [],
        conditionResults: [{ status: "failed" }],
      }),
    /canonical/,
  );
  assert.doesNotThrow(() => assertNativeLinearResult({ results: [] }));
});

test("a false decision crossing the shared quota is the terminal evidence and cannot revive its skipped subtree", async () => {
  const plan = snapshotPlan({
    steps: [
      leaf("large"),
      group("g".repeat(200), [leaf("skipped")], condition(1, "eq", 2)),
      leaf("tail"),
    ],
  });
  const execute = (body) => async () => ({
    status: 200,
    headers: {},
    body,
    durationMs: 0,
  });
  const baseline = await runPlan(plan, {}, execute(""));
  const bytes = Buffer.byteLength(JSON.stringify(baseline.results[0]));
  let calls = 0;
  const result = await runPlan(plan, {}, async () => {
    calls++;
    return execute("x".repeat(REPEAT_EVIDENCE_BYTES - bytes - 100))();
  });
  assert.equal(calls, 1);
  assert.equal(result.stopReason, "evidence-limit");
  assert.equal(result.conditionResults.length, 1);
  assert.equal(result.conditionResults[0].matched, false);
  assert.equal(result.evidenceBudget.last.kind, "condition");
  assert.equal(
    result.evidenceBudget.last.occurrenceId,
    result.conditionResults[0].occurrenceId,
  );
  assert.equal(result.evidenceBudget.next.stepId, "tail");
  assert.equal(result.evidenceBudget.remaining, 1);
  assert.equal(result.evidenceBudget.executed, 1);
});
