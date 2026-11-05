// Cross-feature orchestration tests use injected executors, not wire conformance peers.
import test from "node:test";
import assert from "node:assert/strict";
import { snapshotPlan, runPlan } from "../src/core.mjs";
import { validateRepeatGraph, activePlanLeaves } from "../src/plan-repeat.mjs";
import {
  prepareStagedLoad,
  runStagedLoad,
  buildLoadSchedule,
} from "../src/staged-load-plan.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
const types = ["tcp", "sse", "websocket", "grpc", "socketio"];
const input = {
  initialVUs: 1,
  stages: [{ durationSeconds: 1, targetVUs: 1 }],
  maxIterations: 1,
};
const gate = (steps, matched = true) => ({
  id: "gate",
  type: "if",
  condition: { left: { literal: matched }, op: "eq", right: { literal: true } },
  steps,
});
const fixed = (steps) => ({ id: "fixed", type: "repeat", count: 2, steps });
const http = () => ({ id: "sentinel", request: { url: "http://127.0.0.1:1" } });
function leaf(type) {
  const common = {
    id: type,
    extract: [
      {
        name: "token",
        path: type === "grpc" || type === "socketio" ? "$[0].token" : "$.token",
        scope: "environment",
      },
    ],
  };
  if (type === "grpc")
    return {
      ...common,
      type,
      grpc: {
        definition: {
          id: type,
          target: "grpc://127.0.0.1:1",
          proto:
            'syntax = "proto3"; package fixture; message Value { string token = 1; } service Echo { rpc Unary(Value) returns (Value); }',
          service: "fixture.Echo",
          method: "Unary",
        },
        messages: [{}],
      },
    };
  if (type === "socketio")
    return {
      ...common,
      type,
      socketio: {
        definition: { id: type, url: "http://127.0.0.1:1" },
        commands: [],
      },
    };
  return {
    ...common,
    type: "protocol",
    protocol: {
      definition: {
        id: type,
        type,
        url:
          type === "tcp"
            ? "127.0.0.1"
            : type === "sse"
              ? "http://127.0.0.1:1"
              : "ws://127.0.0.1:1",
        ...(type === "tcp" ? { port: 1 } : {}),
      },
      ...(type !== "sse" ? { message: "fixture" } : {}),
    },
  };
}
function executors(dispatches) {
  const result = (type) => {
    dispatches.push(type);
    return { token: type };
  };
  return {
    executeProtocol: async ({ definition }) => ({
      status: "completed",
      durationMs: 0,
      result: result(definition.type),
    }),
    executeGrpc: async () => ({
      status: { code: 0 },
      durationMs: 0,
      messages: [result("grpc")],
    }),
    executeSocketIO: async () => ({
      status: "passed",
      durationMs: 0,
      results: [result("socketio")],
    }),
  };
}
const noHTTP = async () => assert.fail("unexpected HTTP dispatch");
for (const selected of [types.slice(0, 4), types]) {
  test(`${selected.length}-protocol IF chain preserves order, repeated extraction, and input snapshot`, async () => {
    const source = { steps: [gate([fixed(selected.map(leaf))])] };
    const before = structuredClone(source),
      dispatches = [];
    const plan = snapshotPlan(source);
    assert.deepEqual(
      activePlanLeaves(plan.steps).map((s) => s.id),
      selected,
    );
    const run = await runPlan(
      plan,
      { token: "initial" },
      noHTTP,
      executors(dispatches),
    );
    assert.equal(run.status, "passed", JSON.stringify(run.results));
    assert.deepEqual(dispatches, [...selected, ...selected]);
    assert.deepEqual(
      run.results.map((r) => r.stepId),
      dispatches,
    );
    assert.equal(run.variables.token, selected.at(-1));
    assert.deepEqual(source, before);
  });
}
for (const type of types) {
  test(`${type} retains staged and runtimeRows restrictions inside mixed IF`, async () => {
    const noRead = new Proxy(
      {},
      {
        get() {
          assert.fail("project read before admission");
        },
      },
    );
    for (const matched of [true, false]) {
      const snapshot = { steps: [http(), gate(types.map(leaf), matched)] };
      assert.throws(() => prepareStagedLoad(noRead, snapshot, input), /HTTP/);
      await assert.rejects(
        runStagedLoad(noRead, { snapshot, schedule: buildLoadSchedule(input) }),
        /HTTP/,
      );
      for (const enabled of [true, false]) {
        const child = { ...leaf(type), enabled };
        const rows = {
          id: "rows",
          type: "repeat",
          rowsFrom: { scope: "runtime", name: "items" },
          maxRows: 2,
          steps: [gate([child], matched)],
        };
        assert.throws(
          () =>
            validateRepeatGraph([rows], {
              requireIds: true,
              allowRuntimeRows: true,
            }),
          /运行时数据行循环.*仅支持HTTP/,
        );
        await assert.rejects(
          runPlan({ steps: [rows] }, {}, noHTTP, { allowRuntimeRows: true }),
          /运行时数据行循环.*仅支持HTTP/,
        );
      }
    }
  });
  test(`${type} unknown commit halts a mixed IF chain without dispatching later protocols`, async () => {
    const ordered = [type, ...types.filter((x) => x !== type)];
    const dispatches = [];
    let commits = 0;
    const plan = snapshotPlan({
      failurePolicy: "continue",
      steps: [gate([fixed(ordered.map(leaf))]), http()],
    });
    const run = await runPlan(plan, { token: "initial" }, noHTTP, {
      ...executors(dispatches),
      onScopeChanges: async () => {
        commits++;
        throw new ProjectCommitUncertain("fixture", Error("unknown"));
      },
    });
    assert.equal(run.status, "failed");
    assert.equal(run.stopReason, "scope-commit-unknown");
    assert.equal(commits, 1);
    assert.deepEqual(dispatches, [type]);
    assert.equal(run.results.length, 1);
    assert.deepEqual(run.results[0].scopeCommit, {
      outcome: "unknown",
      retrySafe: false,
    });
    assert.equal(run.variables.token, "initial");
  });
  test(`${type} unrelated non-IF sibling retains legacy unknown-commit continuation beside mixed false IF`, async () => {
    const dispatches = [];
    const skipped = types
      .filter((x) => !["tcp", "sse", "websocket"].includes(type) || x !== type)
      .map((x) => ({ ...leaf(x), id: `skipped-${x}` }));
    const sibling = leaf(type),
      tail = { ...leaf(type), id: "tail", extract: [] };
    const plan = snapshotPlan({
      failurePolicy: "continue",
      steps: [gate(skipped, false), sibling, tail],
    });
    let commits = 0;
    const run = await runPlan(plan, { token: "initial" }, noHTTP, {
      ...executors(dispatches),
      onScopeChanges: async () => {
        commits++;
        throw new ProjectCommitUncertain("fixture", Error("unknown"));
      },
    });
    assert.equal(run.status, "failed");
    assert.equal(run.stopReason, undefined);
    assert.equal(commits, 1);
    assert.deepEqual(dispatches, [type, type]);
    assert.deepEqual(
      run.results.map((r) => r.stepId),
      [type, "tail"],
    );
    assert.equal(run.variables.token, "initial");
  });
}

// Existing wire contract is type-scoped, unlike gRPC/Socket.IO leaf-ID scoping.
// A false IF still opts this wire type into unknown-commit fail-stop behavior.
for (const type of ["tcp", "sse", "websocket"]) {
  test(`${type} same-type non-IF sibling preserves existing type-scoped fail-stop`, async () => {
    const skipped = types.map((x) => ({ ...leaf(x), id: `skipped-${x}` }));
    const dispatches = [];
    let commits = 0;
    const plan = snapshotPlan({
      failurePolicy: "continue",
      steps: [gate(skipped, false), leaf(type), http()],
    });
    const run = await runPlan(plan, { token: "initial" }, noHTTP, {
      ...executors(dispatches),
      onScopeChanges: async () => {
        commits++;
        throw new ProjectCommitUncertain("fixture", Error("unknown"));
      },
    });
    assert.equal(run.status, "failed");
    assert.equal(run.stopReason, "scope-commit-unknown");
    assert.equal(commits, 1);
    assert.deepEqual(dispatches, [type]);
    assert.equal(run.results.length, 1);
    assert.deepEqual(run.results[0].scopeCommit, {
      outcome: "unknown",
      retrySafe: false,
    });
    assert.equal(run.variables.token, "initial");
  });
}
