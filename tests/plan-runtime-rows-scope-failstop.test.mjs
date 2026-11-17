import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlan, snapshotPlan } from "../src/core.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import { recordPlanRun } from "../src/plan-evidence.mjs";
import { Store } from "../src/runtime.mjs";

const http = (id) => ({ id, request: { url: "http://example.invalid" } });
const condition = (matched, steps) => ({
  id: "guard",
  type: "if",
  condition: { op: "eq", left: { literal: matched }, right: { literal: true } },
  steps,
});
const rows = () => ({
  id: "rows",
  type: "repeat",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 2,
  steps: [http("child")],
});
function producer(type) {
  const base = {
    id: "producer",
    extract: [{ name: "saved", path: "$[0].value", scope: "environment" }],
  };
  if (type === "grpc")
    return {
      ...base,
      type,
      grpc: {
        definition: {
          target: "grpc://localhost:50051",
          proto:
            'syntax = "proto3"; service Echo { rpc Call (Msg) returns (Msg); } message Msg {}',
          service: "Echo",
          method: "Call",
        },
        messages: [{}],
      },
    };
  if (type === "socketio")
    return {
      ...base,
      type,
      socketio: {
        definition: {
          url: "http://localhost:3000",
          version: 4,
          transport: "websocket",
        },
        commands: [{ type: "wait", event: "hello", timeoutMs: 50 }],
      },
    };
  return {
    ...base,
    type: "protocol",
    extract: [{ name: "saved", path: "$.body", scope: "environment" }],
    protocol: {
      definition:
        type === "tcp"
          ? { type, url: "localhost", port: 12345 }
          : {
              type,
              url:
                type === "sse"
                  ? "http://localhost/events"
                  : "ws://localhost/socket",
            },
    },
  };
}
async function execute(type, failurePolicy, layout, errorKind, extra = {}) {
  let transports = 0,
    httpCalls = 0,
    commits = 0;
  const group = rows();
  if (layout === "disabled") group.enabled = false;
  const selected =
    layout === "skipped"
      ? condition(false, [group])
      : layout === "nested"
        ? { id: "outer", type: "repeat", count: 2, steps: [group] }
        : group;
  const plan = snapshotPlan(
    {
      failurePolicy,
      steps: [
        producer(type),
        selected,
        http("tail"),
        { ...producer(type), id: "later-protocol" },
      ],
    },
    { allowRuntimeRows: true },
  );
  const exchange = async () => {
    transports++;
    return type === "grpc"
      ? { status: { code: 0 }, durationMs: 0, messages: [{ value: "new" }] }
      : type === "socketio"
        ? { status: "passed", durationMs: 0, results: [{ value: "new" }] }
        : { status: "completed", durationMs: 0, result: { body: "new" } };
  };
  const run = await runPlan(
    plan,
    {},
    async () => {
      httpCalls++;
      return { status: 200, headers: {}, body: "ok" };
    },
    {
      allowRuntimeRows: true,
      variableScopes: {
        environment: { saved: "old" },
        runtime: { items: layout === "empty" ? [] : [{}] },
      },
      executeProtocol: exchange,
      executeGrpc: exchange,
      executeSocketIO: exchange,
      onScopeChanges: async () => {
        commits++;
        if (errorKind === "class")
          throw new ProjectCommitUncertain(
            "project",
            Error("private-storage-secret"),
          );
        throw Object.assign(Error("private-storage-secret"), {
          code:
            errorKind === "definite"
              ? "WRITE_FAILED"
              : "PROJECT_COMMIT_UNCERTAIN",
          details: "private-storage-secret",
        });
      },
      ...extra,
    },
  );
  return { run, transports, httpCalls, commits };
}
for (const type of ["tcp", "websocket", "sse", "grpc", "socketio"])
  for (const policy of ["continue", "stop"])
    for (const layout of ["direct", "nested", "skipped", "empty"])
      for (const errorKind of ["code", "class"])
        test(`${type} ${policy} ${layout} runtime rows stop on ${errorKind} uncertain producer commit`, async () => {
          const { run, transports, httpCalls, commits } = await execute(
            type,
            policy,
            layout,
            errorKind,
          );
          assert.equal(transports, 1);
          assert.equal(httpCalls, 0);
          assert.equal(commits, 1);
          assert.equal(run.stopReason, "scope-commit-unknown");
          assert.equal(run.results.length, 1);
          assert.deepEqual(run.results[0].scopeCommit, {
            outcome: "unknown",
            retrySafe: false,
          });
          assert.deepEqual(run.results[0].extracted, {});
          assert.equal(run.variables.saved, "old");
          assert.equal(run.conditionResults?.length || 0, 0);
          assert.equal(
            JSON.stringify(run).includes("private-storage-secret"),
            false,
          );
        });

test("uncertain producer evidence survives real record persistence and restart without private error details", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rows-scope-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const project = await store.create("scope stop");
  const { run, transports } = await execute(
    "tcp",
    "continue",
    "direct",
    "code",
  );
  await recordPlanRun(store, project.id, run, "manual");
  const saved = (await new Store(root).get(project.id)).runs[0];
  assert.equal(transports, 1);
  assert.equal(saved.stopReason, "scope-commit-unknown");
  assert.deepEqual(saved.results[0].scopeCommit, {
    outcome: "unknown",
    retrySafe: false,
  });
  assert.equal(saved.results[0].protocolResult.result.body, "new");
  assert.equal(saved.variables.saved, "old");
  assert.deepEqual(saved.results[0].extracted, {});
  assert.equal(JSON.stringify(saved).includes("private-storage-secret"), false);
});

for (const policy of ["continue", "stop"])
  test(`definite producer commit failure retains ${policy} policy`, async () => {
    const { run, transports, httpCalls } = await execute(
      "tcp",
      policy,
      "direct",
      "definite",
    );
    assert.equal(run.results[0].scopeCommit, undefined);
    assert.notEqual(run.stopReason, "scope-commit-unknown");
    assert.equal(run.variables.saved, "old");
    assert.equal(httpCalls, policy === "stop" ? 0 : 2);
    assert.equal(transports, policy === "stop" ? 1 : 2);
  });

test("disabled runtime rows do not broaden legacy ordinary producer behavior", async () => {
  const { run, transports, httpCalls } = await execute(
    "tcp",
    "continue",
    "disabled",
    "code",
  );
  assert.equal(run.results[0].scopeCommit, undefined);
  assert.notEqual(run.stopReason, "scope-commit-unknown");
  assert.equal(httpCalls, 1);
  assert.equal(transports, 2);
});
