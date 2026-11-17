import test from "node:test";
import assert from "node:assert/strict";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { validateRepeatGraph } from "../src/plan-repeat.mjs";
const condition = (value = true) => ({
  op: "eq",
  left: { literal: value },
  right: { literal: true },
});
const wire = (type = "tcp") => ({
  id: "wire",
  type: "protocol",
  protocol: {
    definition: { type, url: "127.0.0.1", port: 1234 },
    message: "ping",
  },
  extract: [{ name: "token", path: "$.body", scope: "environment" }],
});
const loop = (steps = [wire()], extra = {}) => ({
  id: "loop",
  type: "repeat",
  count: 3,
  untilCondition: condition(),
  steps,
  ...extra,
});
const http = () => ({ id: "http", request: { url: "http://example.invalid" } });
const response = async () => ({
  status: 200,
  headers: {},
  body: "ok",
  duration: 0,
});
const protocol = async () => ({
  status: "completed",
  result: { body: "ready" },
});

test("until TCP admission intersects IF, fixed repeats and runtime-row policies, including disabled branches", () => {
  for (const enabled of [true, false]) {
    for (const nest of [
      (x) => x,
      (x) => ({
        id: "if",
        type: "if",
        condition: condition(false),
        steps: [x],
      }),
      (x) => ({ id: "fixed", type: "repeat", count: 2, steps: [x] }),
    ]) {
      assert.equal(
        validateRepeatGraph([loop([nest(wire())], { enabled })], {
          requireIds: true,
        }),
        true,
      );
      for (const type of ["unknown"])
        assert.throws(
          () =>
            validateRepeatGraph([loop([nest(wire(type))], { enabled })], {
              requireIds: true,
            }),
          /HTTP或TCP/,
        );
    }
  }
  assert.equal(
    validateRepeatGraph(
      [
        {
          id: "rows",
          type: "repeat",
          rowsFrom: { scope: "runtime", name: "rows" },
          maxRows: 2,
          steps: [loop()],
        },
      ],
      { requireIds: true, allowRuntimeRows: true },
    ),
    true,
  );
  assert.throws(
    () =>
      validateRepeatGraph(
        [
          loop([wire()], {
            count: 100,
            steps: [{ id: "inner", type: "repeat", count: 3, steps: [wire()] }],
          }),
        ],
        { requireIds: true },
      ),
    /200/,
  );
});

test("until TCP missing executor rejects before earlier HTTP even when body is under false IF", async () => {
  for (const steps of [
    [wire()],
    [{ id: "if", type: "if", condition: condition(false), steps: [wire()] }],
  ]) {
    let calls = 0;
    await assert.rejects(
      runPlan(snapshotPlan({ steps: [http(), loop(steps)] }), {}, async () => {
        calls++;
        return response();
      }),
      /未授权protocol/,
    );
    assert.equal(calls, 0);
  }
});

test("TCP tail condition exhaustion and uncertain scope commits stop without another exchange", async () => {
  let calls = 0;
  const plan = snapshotPlan({
    steps: [
      loop([], { steps: [wire()], untilCondition: condition(false), count: 2 }),
      http(),
    ],
  });
  const exhausted = await runPlan(plan, {}, response, {
    executeProtocol: async () => {
      calls++;
      return protocol();
    },
  });
  assert.equal(exhausted.stopReason, "repeat-condition-exhausted");
  assert.equal(calls, 2);
  assert.equal(exhausted.results.length, 2);
  assert.deepEqual(
    exhausted.conditionResults.map((r) => r.matched),
    [false, false],
  );
  calls = 0;
  const unknown = await runPlan(plan, { token: "original" }, response, {
    executeProtocol: async () => {
      calls++;
      return protocol();
    },
    onScopeChanges: async () => {
      throw Object.assign(Error("unknown"), {
        code: "PROJECT_COMMIT_UNCERTAIN",
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(unknown.results[0].scopeCommit.outcome, "unknown");
  assert.equal(unknown.conditionResults.length, 0);
  assert.equal(unknown.variables.token, "original");
});
