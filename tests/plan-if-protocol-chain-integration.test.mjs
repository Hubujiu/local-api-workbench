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
      status: { code: 0, details: "OK" },
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
  test(`${type} retains staged restrictions and runtimeRows capability intersections inside mixed IF`, async () => {
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
        if (["tcp", "websocket", "grpc"].includes(type)) {
          assert.equal(
            validateRepeatGraph([rows], {
              requireIds: true,
              allowRuntimeRows: true,
            }),
            true,
          );
          let dispatched = 0;
          const run = await runPlan({ steps: [rows] }, {}, noHTTP, {
            allowRuntimeRows: true,
            variableScopes: { runtime: { items: [{}] } },
            executeGrpc: async () => {
              dispatched++;
              return {
                status: { code: 0, details: "OK" },
                messages: [{ token: "ok" }],
                durationMs: 0,
              };
            },
            executeProtocol: async () => {
              dispatched++;
              return { status: "completed", result: { token: "ok" } };
            },
          });
          assert.equal(run.status, "passed");
          assert.equal(dispatched, matched && enabled ? 1 : 0);
          continue;
        }
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
    assert.equal(commits, 1, JSON.stringify(run.results));
    assert.deepEqual(dispatches, [type]);
    assert.equal(run.results.length, 1);
    assert.deepEqual(run.results[0].scopeCommit, {
      outcome: "unknown",
      retrySafe: false,
    });
    assert.equal(run.variables.token, "initial");
  });
  test(`${type} non-IF sibling retains legacy unknown-commit continuation beside disabled IF`, async () => {
    const dispatches = [];
    const skipped = types
      .filter((x) => !["tcp", "sse", "websocket"].includes(type) || x !== type)
      .map((x) => ({ ...leaf(x), id: `skipped-${x}` }));
    const sibling = leaf(type),
      tail = { ...leaf(type), id: "tail", extract: [] };
    const plan = snapshotPlan({
      failurePolicy: "continue",
      steps: [{ ...gate(skipped, false), enabled: false }, sibling, tail],
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
    assert.equal(commits, 1, JSON.stringify(run.results));
    assert.deepEqual(dispatches, [type, type]);
    assert.deepEqual(
      run.results.map((r) => r.stepId),
      [type, "tail"],
    );
    assert.equal(run.variables.token, "initial");
  });
}

// A false but enabled IF opts the entire plan into unknown-commit fail-stop.
for (const type of ["tcp", "sse", "websocket"]) {
  test(`${type} same-type non-IF sibling retains fail-stop beside a false IF`, async () => {
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
    assert.equal(commits, 1, JSON.stringify(run.results));
    assert.deepEqual(dispatches, [type]);
    assert.equal(run.results.length, 1);
    assert.deepEqual(run.results[0].scopeCommit, {
      outcome: "unknown",
      retrySafe: false,
    });
    assert.equal(run.variables.token, "initial");
  });
}

// Persistence succeeds through the real Store, then the acknowledgement is lost.
// Protocol executors remain injected; HTTP uses a loopback peer. This is not a
// journal crash simulation and does not claim real wire conformance coverage.
test("active IF fail-stops after durable scope write with lost acknowledgement", async (t) => {
  const { Store, executeRequest } = await import("../src/runtime.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createServer } = await import("node:http");
  const root = await mkdtemp(join(tmpdir(), "if-durable-unknown-"));
  const store = new Store(root);
  let hits = 0;
  const peer = createServer((_req, res) => {
    hits++;
    res.setHeader("content-type", "application/json");
    res.end('{"token":"http"}');
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise((resolve) => peer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${peer.address().port}`;
  const httpLeaf = (id, extract = []) => ({ id, request: { url, extract } });
  for (const type of ["http", ...types])
    for (const mode of [
      "true",
      "false",
      "disabled",
      "disabled-ancestor",
      "none",
      "repeat",
      "completed",
      "until",
      "rows",
    ])
      for (const kind of ["instance", "code"])
        if (
          !["until", "rows"].includes(mode) ||
          type === "http" ||
          (mode === "until" && ["tcp", "websocket"].includes(type))
        )
          await t.test(`${type}/${mode}/${kind}`, async () => {
            const project = await store.create(
              "durable acknowledgement fixture",
            );
            project.environments[0].variables = { token: "initial" };
            await store.save(project);
            const producer =
              type === "http"
                ? httpLeaf("http", [
                    { name: "token", path: "$.token", scope: "environment" },
                  ])
                : leaf(type);
            const choice = gate([httpLeaf("branch")], mode !== "false");
            // The branch would use the stale in-memory value if execution continued.
            if (mode === "true")
              choice.condition = {
                left: { scope: "environment", name: "token" },
                op: "eq",
                right: { literal: "initial" },
              };
            let steps;
            if (mode === "none") steps = [producer, httpLeaf("tail")];
            else if (mode === "completed")
              steps = [
                gate([httpLeaf("branch")], false),
                producer,
                httpLeaf("tail"),
              ];
            else if (mode === "until")
              steps = [
                {
                  ...fixed([producer, httpLeaf("tail")]),
                  untilCondition: choice.condition,
                },
              ];
            else if (mode === "rows")
              steps = [
                {
                  id: "rows",
                  type: "repeat",
                  rowsFrom: { scope: "runtime", name: "items" },
                  maxRows: 2,
                  steps: [producer, httpLeaf("tail")],
                },
              ];
            else if (mode === "repeat")
              steps = [fixed([producer, choice]), httpLeaf("tail")];
            else {
              if (mode === "disabled") choice.enabled = false;
              const control =
                mode === "disabled-ancestor"
                  ? { ...fixed([choice]), enabled: false }
                  : choice;
              steps = [producer, control, httpLeaf("tail")];
            }
            const active = [
              "true",
              "false",
              "repeat",
              "completed",
              "until",
              "rows",
            ].includes(mode);
            const plan = snapshotPlan(
              { failurePolicy: "continue", steps },
              { allowRuntimeRows: true },
            );
            const dispatches = [],
              beforeHits = hits;
            let commits = 0;
            const run = await runPlan(
              plan,
              { token: "initial" },
              executeRequest,
              {
                ...executors(dispatches),
                allowRuntimeRows: true,
                variableScopes: {
                  environment: { token: "initial" },
                  runtime: { items: [{}, {}] },
                  globals: {},
                },
                onScopeChanges: async (changes) => {
                  commits++;
                  const saved = await store.get(project.id);
                  for (const change of changes) {
                    assert.equal(change.scope, "environment");
                    saved.environments[0].variables[change.name] =
                      change.after.value;
                  }
                  await store.save(saved);
                  assert.equal(
                    (await store.get(project.id)).environments[0].variables
                      .token,
                    type,
                  );
                  if (kind === "instance")
                    throw new ProjectCommitUncertain(
                      project.id,
                      Error("acknowledgement lost after successful save"),
                    );
                  throw Object.assign(
                    Error("acknowledgement lost after successful save"),
                    { code: "PROJECT_COMMIT_UNCERTAIN" },
                  );
                },
              },
            );
            assert.equal(commits, 1, JSON.stringify(run.results));
            assert.equal(
              (await store.get(project.id)).environments[0].variables.token,
              type,
            );
            assert.equal(run.variables.token, "initial");
            assert.equal(run.status, "failed");
            assert.equal(
              run.stopReason,
              active ? "scope-commit-unknown" : undefined,
            );
            assert.equal(run.results.length, active ? 1 : 2);
            const evidence = run.results[0];
            if (type === "http")
              assert.equal(JSON.parse(evidence.response.body).token, type);
            else if (type === "grpc")
              assert.equal(evidence.grpcResult.messages[0].token, type);
            else if (type === "socketio")
              assert.equal(evidence.socketioResult.results[0].token, type);
            else assert.equal(evidence.protocolResult.result.token, type);
            if (active || kind === "instance" || type === "http")
              assert.deepEqual(run.results[0].scopeCommit, {
                outcome: "unknown",
                retrySafe: false,
              });
            assert.equal(
              hits - beforeHits,
              (type === "http" ? 1 : 0) + (active ? 0 : 1),
            );
            assert.deepEqual(dispatches, type === "http" ? [] : [type]);
            assert.equal(
              run.conditionResults?.length ?? 0,
              mode === "completed" ? 1 : 0,
            );
            if (mode === "repeat")
              assert.equal(run.results[0].repeat.iteration, 0);
          });
  for (const type of ["tcp", "grpc"])
    for (const phase of ["before", "after"])
      for (const active of [true, false])
        for (const kind of ["instance", "code"])
          await t.test(
            `scripted/${type}/${phase}/active=${active}/${kind}`,
            async () => {
              const project = await store.create(
                "script durable acknowledgement fixture",
              );
              project.environments[0].variables = { token: "initial" };
              await store.save(project);
              const producer = leaf(type);
              producer.extract = [];
              producer[type === "grpc" ? "grpcScripts" : "protocolScripts"] = {
                version: 1,
                [phase]: `pm.environment.set('token','${type}');`,
              };
              const plan = snapshotPlan({
                failurePolicy: "continue",
                steps: [
                  producer,
                  ...(active ? [gate([httpLeaf("branch")], false)] : []),
                  httpLeaf("tail"),
                ],
              });
              let commits = 0;
              const dispatches = [],
                beforeHits = hits;
              const run = await runPlan(
                plan,
                { token: "initial" },
                executeRequest,
                {
                  ...executors(dispatches),
                  executeProtocol: async () => {
                    dispatches.push("tcp");
                    return {
                      type: "tcp",
                      status: "completed",
                      durationMs: 0,
                      result: {
                        body: "tcp",
                        base64: Buffer.from("tcp").toString("base64"),
                        size: 3,
                        timedOut: false,
                        partial: false,
                      },
                    };
                  },
                  onScopeChanges: async (changes) => {
                    commits++;
                    const saved = await store.get(project.id);
                    for (const change of changes)
                      saved.environments[0].variables[change.name] =
                        change.after.value;
                    await store.save(saved);
                    if (kind === "instance")
                      throw new ProjectCommitUncertain(
                        project.id,
                        Error("lost ack"),
                      );
                    throw Object.assign(Error("lost ack"), {
                      code: "PROJECT_COMMIT_UNCERTAIN",
                    });
                  },
                },
              );
              assert.equal(commits, 1, JSON.stringify(run.results));
              assert.equal(
                (await store.get(project.id)).environments[0].variables.token,
                type,
              );
              assert.equal(run.variables.token, "initial");
              assert.equal(run.status, "failed");
              assert.equal(
                run.stopReason,
                active ? "scope-commit-unknown" : undefined,
              );
              assert.equal(run.results.length, 1);
              assert.deepEqual(run.results[0].scopeCommit, {
                outcome: "unknown",
                retrySafe: false,
                phase,
              });
              assert.deepEqual(dispatches, phase === "before" ? [] : [type]);
              assert.equal(hits, beforeHits);
            },
          );
});
