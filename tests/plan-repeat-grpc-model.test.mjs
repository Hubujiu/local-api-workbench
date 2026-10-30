// Pure graph/transport admission only: no executor, app, VM, database or sockets.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRepeatGraph,
  planLeaves,
  activePlanLeaves,
  planOccurrences,
} from "../src/plan-repeat.mjs";
import { grpcPlanCredentials } from "../src/grpc-plan.mjs";
const leaf = () => ({
  id: "rpc",
  type: "grpc",
  grpc: {
    definition: {
      target: "grpc://127.0.0.1:50051",
      requiredMetadata: ["authorization"],
    },
    messages: [{}],
  },
  extract: [],
  assertions: [],
});
const graph = () => [
  {
    id: "group",
    type: "repeat",
    count: 2,
    steps: [
      leaf(),
      { id: "http", request: { url: "http://localhost/consume" } },
    ],
  },
];
const credentials = () => ({
  rpc: { metadata: [{ key: "authorization", value: "Bearer fixture-only" }] },
});
test("gRPC repeat graph has stable leaves and distinct occurrence IDs", () => {
  const steps = graph(),
    before = structuredClone(steps);
  assert.equal(validateRepeatGraph(steps, { requireIds: true }), true);
  assert.deepEqual(
    planLeaves(steps).map((x) => x.id),
    ["rpc", "http"],
  );
  assert.deepEqual(activePlanLeaves(steps), planLeaves(steps));
  const occurrences = planOccurrences(steps);
  assert.deepEqual(
    occurrences.map((x) => [x.step.id, x.repeat.iteration]),
    [
      ["rpc", 0],
      ["http", 0],
      ["rpc", 1],
      ["http", 1],
    ],
  );
  assert.equal(new Set(occurrences.map((x) => x.repeat.occurrenceId)).size, 4);
  assert.deepEqual(steps, before);
});
test("gRPC references resolve before frozen admission and no wrapper extras are admitted", () => {
  const steps = graph();
  steps[0].steps[0].grpc = { definitionId: "saved" };
  assert.equal(validateRepeatGraph(steps), true);
  assert.throws(
    () => validateRepeatGraph(steps, { requireIds: true }),
    /冻结前/,
  );
  steps[0].steps[0].grpc.definition = {};
  assert.throws(() => validateRepeatGraph(steps), /混合/);
  for (const field of ["scripts", "metadata", "tls", "nativeMCP"]) {
    const bad = graph();
    bad[0].steps[0][field] = {};
    assert.throws(() => validateRepeatGraph(bad), /未知/);
  }
  for (const type of ["socketio", "repeat", "unknown"]) {
    const bad = graph();
    bad[0].steps[0].type = type;
    assert.throws(() => validateRepeatGraph(bad));
  }
  const duplicate = graph();
  duplicate[0].steps[1].id = "rpc";
  assert.throws(() => validateRepeatGraph(duplicate), /重复/);
  const count = graph();
  count[0].count = 101;
  assert.throws(() => validateRepeatGraph(count));
  const size = graph();
  size[0].steps[0].grpc.messages = [{ text: "x".repeat(3 * 1024 * 1024) }];
  assert.throws(() => validateRepeatGraph(size), /4MiB/);
});
test("gRPC credential preflight binds nested stable IDs and honors disabled groups", () => {
  const plan = { steps: graph() },
    input = credentials();
  assert.throws(() => grpcPlanCredentials(plan), /缺少gRPC/);
  const bindings = grpcPlanCredentials(plan, input);
  assert.deepEqual(bindings.get("rpc"), input.rpc);
  input.rpc.metadata[0].value = "changed";
  assert.equal(bindings.get("rpc").metadata[0].value, "Bearer fixture-only");
  const occurrenceId = planOccurrences(plan.steps)[0].repeat.occurrenceId;
  assert.throws(
    () => grpcPlanCredentials(plan, { [occurrenceId]: credentials().rpc }),
    /不存在/,
  );
  plan.steps[0].enabled = false;
  assert.equal(grpcPlanCredentials(plan).size, 0);
  assert.equal(grpcPlanCredentials(plan, credentials()).size, 1);
  plan.steps[0].enabled = true;
  plan.steps[0].steps[0].enabled = false;
  assert.equal(grpcPlanCredentials(plan).size, 0);
});
test("gRPC nested credentials preserve target, metadata, TLS and map admission limits", () => {
  const plan = { steps: graph() };
  for (const extra of [
    { target: "grpc://elsewhere:1" },
    { definition: {} },
    { tls: { rejectUnauthorized: false } },
    { tls: { ca: "not-permitted-on-cleartext" } },
  ]) {
    assert.throws(() =>
      grpcPlanCredentials(plan, { rpc: { ...credentials().rpc, ...extra } }),
    );
  }
  for (const metadata of [
    [{ key: "authorization", value: "bad\nvalue" }],
    [{ key: "grpc-status", value: "0" }],
    [{ key: "authorization", value: "x".repeat(8193) }],
  ]) {
    assert.throws(() => grpcPlanCredentials(plan, { rpc: { metadata } }));
  }
  assert.throws(
    () => grpcPlanCredentials(plan, { missing: credentials().rpc }),
    /不存在/,
  );
  plan.steps[0].steps[0].grpc.definition.target = "grpcs://localhost:50051";
  assert.throws(
    () =>
      grpcPlanCredentials(plan, {
        rpc: { ...credentials().rpc, tls: { key: "x" } },
      }),
    /同时/,
  );
});
test("well-shaped Socket.IO leaf composes with the extended repeat contract", () => {
  const steps = graph();
  steps[0].steps[0] = {
    id: "socket-step",
    type: "socketio",
    socketio: {
      definition: {
        id: "socket",
        name: "Socket.IO",
        url: "http://127.0.0.1:3000",
      },
      timeoutMs: 2000,
      commands: [{ type: "wait", event: "welcome", timeoutMs: 1000 }],
    },
    extract: [],
    assertions: [],
  };
  assert.equal(validateRepeatGraph(steps), true);
});
