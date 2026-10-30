// Pure graph helpers only; no runtime, server, VM, database or sockets.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRepeatGraph,
  planLeaves,
  activePlanLeaves,
  planOccurrences,
} from "../src/plan-repeat.mjs";
const leaf = (type) => ({
  id: type,
  type: "protocol",
  protocol: {
    definition: {
      type,
      url: type === "websocket" ? "ws://localhost" : "http://localhost/events",
    },
  },
});
const graph = () => [
  {
    id: "group",
    type: "repeat",
    count: 2,
    steps: [
      leaf("websocket"),
      leaf("sse"),
      { id: "consume", request: { url: "http://localhost/consume" } },
    ],
  },
];
test("WS/SSE repeat preserves stable leaves and ordered unique occurrences without mutation", () => {
  const steps = graph(),
    original = structuredClone(steps);
  assert.equal(validateRepeatGraph(steps, { requireIds: true }), true);
  assert.deepEqual(
    planLeaves(steps).map((x) => x.id),
    ["websocket", "sse", "consume"],
  );
  const occurrences = planOccurrences(steps);
  assert.deepEqual(
    occurrences.map((x) => [x.step.id, x.repeat.iteration]),
    [
      ["websocket", 0],
      ["sse", 0],
      ["consume", 0],
      ["websocket", 1],
      ["sse", 1],
      ["consume", 1],
    ],
  );
  assert.equal(new Set(occurrences.map((x) => x.repeat.occurrenceId)).size, 6);
  assert.strictEqual(occurrences[0].step, occurrences[3].step);
  assert.deepEqual(steps, original);
});
test("wire references resolve only before freeze; disabled groups keep identity and budget checks", () => {
  for (const type of ["websocket", "sse"]) {
    const steps = graph();
    steps[0].steps[0] = {
      ...leaf(type),
      id: "reference",
      protocol: { definitionId: type },
    };
    assert.equal(validateRepeatGraph(steps), true);
    assert.throws(
      () => validateRepeatGraph(steps, { requireIds: true }),
      /冻结前/,
    );
    steps[0].steps[0].protocol.definition = leaf(type).protocol.definition;
    assert.throws(() => validateRepeatGraph(steps), /混合/);
  }
  const steps = graph();
  steps[0].steps[0].enabled = false;
  assert.deepEqual(
    activePlanLeaves(steps).map((x) => x.id),
    ["sse", "consume"],
  );
  steps[0].enabled = false;
  assert.deepEqual(activePlanLeaves(steps), []);
  steps[0].count = 67;
  assert.throws(() => validateRepeatGraph(steps), /200/);
  steps[0].count = 2;
  steps[0].steps[1].id = "websocket";
  assert.throws(() => validateRepeatGraph(steps), /重复/);
});
test("unsupported transports and nested repeats remain rejected even when disabled", () => {
  for (const type of ["grpc", "socketio", "unknown"]) {
    const steps = graph();
    steps[0].enabled = false;
    steps[0].steps[0].protocol.definition.type = type;
    assert.throws(() => validateRepeatGraph(steps), /仅支持/);
  }
  const steps = graph();
  steps[0].steps[0] = {
    id: "nested",
    type: "repeat",
    count: 1,
    steps: [leaf("sse")],
  };
  assert.throws(() => validateRepeatGraph(steps));
});
