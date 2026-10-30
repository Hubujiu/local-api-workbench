// Pure graph helpers only: no runtime, server, VM, database or socket imports.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRepeatGraph,
  planLeaves,
  activePlanLeaves,
  planOccurrences,
} from "../src/plan-repeat.mjs";
const tcp = () => ({
  id: "tcp",
  type: "protocol",
  protocol: {
    definition: { type: "tcp", url: "127.0.0.1", port: 1234 },
    message: "hello",
  },
  extract: [{ name: "token", path: "$.data" }],
  assertions: [],
  expectedStatus: "completed",
});
const graph = (child = tcp()) => [
  {
    type: "repeat",
    id: "group",
    count: 2,
    steps: [
      child,
      { id: "http", request: { url: "http://localhost/consume" } },
    ],
  },
];
test("TCP repeat retains definition IDs and injective ordered occurrence identities", () => {
  const steps = graph(),
    original = structuredClone(steps);
  assert.equal(validateRepeatGraph(steps, { requireIds: true }), true);
  assert.deepEqual(
    planLeaves(steps).map((x) => x.id),
    ["tcp", "http"],
  );
  const occurrences = planOccurrences(steps);
  assert.deepEqual(
    occurrences.map((x) => [x.step.id, x.repeat.iteration]),
    [
      ["tcp", 0],
      ["http", 0],
      ["tcp", 1],
      ["http", 1],
    ],
  );
  assert.equal(new Set(occurrences.map((x) => x.repeat.occurrenceId)).size, 4);
  assert.strictEqual(occurrences[0].step, occurrences[2].step);
  assert.deepEqual(steps, original);
});
test("reference resolution is permitted only before the frozen graph validation", () => {
  const child = tcp();
  child.protocol = { definitionId: "saved-tcp" };
  assert.equal(validateRepeatGraph(graph(child)), true);
  assert.throws(
    () => validateRepeatGraph(graph(child), { requireIds: true }),
    /冻结前/,
  );
  child.protocol.definition = tcp().protocol.definition;
  assert.throws(() => validateRepeatGraph(graph(child)), /混合/);
});
test("disabled definitions remain validated and budgeted without active leaves", () => {
  const steps = graph();
  steps[0].enabled = false;
  assert.deepEqual(activePlanLeaves(steps), []);
  steps[0].count = 100;
  assert.equal(validateRepeatGraph(steps), true);
  steps.push({ id: "extra", request: { url: "http://localhost" } });
  assert.throws(() => validateRepeatGraph(steps), /200/);
  const oversized = graph();
  oversized[0].enabled = false;
  oversized[0].steps[0].protocol.message = "x".repeat(3 * 1024 * 1024);
  assert.throws(() => validateRepeatGraph(oversized), /4MiB/);
});
test("unsupported nested protocols, identities and structure still reject", () => {
  for (const type of ["sse", "websocket", "unknown"]) {
    const child = tcp();
    child.protocol.definition.type = type;
    assert.throws(() => validateRepeatGraph(graph(child)), /仅支持TCP/);
  }
  for (const type of ["grpc", "socketio", "repeat", "unknown"]) {
    const child = tcp();
    child.type = type;
    assert.throws(() => validateRepeatGraph(graph(child)));
  }
  const duplicate = graph();
  duplicate[0].steps[0].id = "group";
  assert.throws(() => validateRepeatGraph(duplicate), /重复/);
  const unknown = tcp();
  unknown.secret = "not-allowed";
  assert.throws(() => validateRepeatGraph(graph(unknown)), /未知/);
  const accessor = tcp();
  Object.defineProperty(accessor.protocol, "bad", {
    enumerable: true,
    get() {
      throw Error("must not invoke");
    },
  });
  assert.throws(() => validateRepeatGraph(graph(accessor)), /访问器/);
});
