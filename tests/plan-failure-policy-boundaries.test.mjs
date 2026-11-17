import test from "node:test";
import assert from "node:assert/strict";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import {
  readPlanFailurePolicy,
  failureStopSummary,
} from "../src/plan-failure-policy.mjs";
import { assertNativeLinearPlan } from "../src/native-mcp-plan.mjs";
import { assertNativeLinearResult } from "../src/native-mcp-tools.mjs";
const input = () => ({
  id: "p",
  steps: [
    { id: "a", request: { id: "r1", url: "http://127.0.0.1:1/never" } },
    { id: "b", request: { id: "r2", url: "http://127.0.0.1:1/never" } },
  ],
});
const response = () => ({
  status: 401,
  headers: {},
  body: "completed",
  duration: 1,
});
test("policy admission rejects hooks and malformed values before any executor or observer", async () => {
  let hooks = 0,
    calls = 0;
  const getter = input();
  Object.defineProperty(getter, "failurePolicy", {
    enumerable: true,
    get() {
      hooks++;
      return "stop";
    },
  });
  const proxy = new Proxy(input(), {
    get() {
      hooks++;
      return "stop";
    },
    getOwnPropertyDescriptor() {
      hooks++;
      return undefined;
    },
  });
  for (const plan of [
    getter,
    proxy,
    { ...input(), failurePolicy: undefined },
    { ...input(), failurePolicy: null },
  ]) {
    assert.throws(() => snapshotPlan(plan), /失败策略/);
    await assert.rejects(
      () =>
        runPlan(plan, {}, async () => {
          calls++;
          return response();
        }),
      /失败策略/,
    );
  }
  assert.equal(hooks, 0);
  assert.equal(calls, 0);
});
test("direct linear continue has the same snapshot and hash as omitted policy", async () => {
  const plan = snapshotPlan(input());
  const old = await runPlan(plan, {}, async () => response());
  const explicit = await runPlan(
    { ...plan, failurePolicy: "continue" },
    {},
    async () => response(),
  );
  assert.deepEqual(old.snapshot, explicit.snapshot);
  assert.equal(old.planHash, explicit.planHash);
  assert.equal(old.results.length, 2);
  assert.equal(explicit.results.length, 2);
});
test("failed leaf observer completes once before policy stop and prior observer failure remains fail-stop", async () => {
  const plan = snapshotPlan({ ...input(), failurePolicy: "stop" });
  let calls = 0,
    observations = 0;
  const execute = async () => {
    calls++;
    return response();
  };
  const run = await runPlan(plan, {}, execute, {
    onStep: async (r) => {
      observations++;
      assert.equal(r.status, "failed");
    },
  });
  assert.equal(calls, 1);
  assert.equal(observations, 1);
  assert.equal(run.stopReason, "step-failure");
  calls = 0;
  const interrupted = await runPlan(plan, {}, execute, {
    onStep: () => {
      throw Error("observer fixture");
    },
  });
  assert.equal(calls, 1);
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.stopReason, "progress-failure");
  assert.equal(interrupted.failureStop, undefined);
  assert.equal(interrupted.results[0].status, "failed");
  assert.equal(interrupted.results[0].response.body, "completed");
  assert.equal(interrupted.progressFailure.retry_safe, false);
  assert.doesNotMatch(JSON.stringify(interrupted), /observer fixture/);
});
test("cancellation during completed failed leaf observer has priority over ordinary stop", async () => {
  const controller = new AbortController();
  const run = await runPlan(
    snapshotPlan({ ...input(), failurePolicy: "stop" }),
    {},
    async () => response(),
    { signal: controller.signal, onStep: () => controller.abort() },
  );
  assert.equal(run.status, "cancelled");
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].response.body, "completed");
  assert.equal(run.failureStop, undefined);
  assert.equal(run.stopReason, undefined);
});
test("false and disabled children create neither ordinary failure nor fake results", async () => {
  let calls = 0;
  const [a, b] = input().steps;
  const plan = snapshotPlan({
    id: "p",
    failurePolicy: "stop",
    steps: [
      {
        type: "if",
        id: "gate",
        condition: { op: "eq", left: { literal: 1 }, right: { literal: 2 } },
        steps: [a],
      },
      { ...b, enabled: false },
    ],
  });
  const run = await runPlan(plan, {}, async () => {
    calls++;
    return response();
  });
  assert.equal(calls, 0);
  assert.equal(run.status, "passed");
  assert.equal(run.stopReason, undefined);
  assert.deepEqual(run.results, []);
});
test("stop definitions and snapshotless stop evidence cannot lose semantics in native projection", () => {
  const plan = snapshotPlan({ ...input(), failurePolicy: "stop" });
  assert.throws(() => assertNativeLinearPlan(plan), /失败停止/);
  for (const run of [
    { snapshot: plan },
    { stopReason: "step-failure" },
    { failureStop: { stepId: "a" } },
    { stopReason: "scope-commit-unknown" },
  ])
    assert.throws(() => assertNativeLinearResult(run), /失败停止/);
  assert.doesNotThrow(() => assertNativeLinearPlan(snapshotPlan(input())));
});
test("history stop summary admits only bounded identity, not arbitrary imported payload or hooks", () => {
  let hooks = 0;
  const raw = {
    stepId: "a",
    secret: "must-not-project",
    repeat: {
      groupId: "r",
      childId: "a",
      iteration: 0,
      occurrenceId: '["r","a",0]',
      extra: "must-not-project",
    },
  };
  assert.deepEqual(
    failureStopSummary({ stopReason: "step-failure", failureStop: raw }),
    {
      stopReason: "step-failure",
      failureStop: {
        stepId: "a",
        repeat: {
          groupId: "r",
          childId: "a",
          iteration: 0,
          occurrenceId: '["r","a",0]',
        },
      },
    },
  );
  const hostile = { stepId: "a" };
  Object.defineProperty(hostile, "repeat", {
    enumerable: true,
    get() {
      hooks++;
      return raw.repeat;
    },
  });
  assert.deepEqual(
    failureStopSummary({ stopReason: "step-failure", failureStop: hostile }),
    { stopReason: "step-failure", failureStop: { stepId: "a" } },
  );
  assert.deepEqual(
    failureStopSummary({
      stopReason: "step-failure",
      failureStop: { stepId: "x".repeat(201) },
    }),
    { stopReason: "step-failure" },
  );
  assert.equal(hooks, 0);
  assert.equal(readPlanFailurePolicy({ failurePolicy: "continue" }), undefined);
});
