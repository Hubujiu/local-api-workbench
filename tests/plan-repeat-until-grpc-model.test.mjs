// Pure capability intersections; transport completion is covered by real peers.
import test from "node:test";
import assert from "node:assert/strict";
import { validateRepeatGraph, activePlanLeaves } from "../src/plan-repeat.mjs";
const condition = {
  left: { literal: true },
  op: "eq",
  right: { literal: true },
};
const leaf = () => ({ id: "rpc", type: "grpc", grpc: { definition: {} } });
const repeat = (id, steps) => ({ id, type: "repeat", count: 2, steps });
const until = (id, steps) => ({
  ...repeat(id, steps),
  untilCondition: condition,
});
const gate = (steps) => ({
  id: "gate",
  type: "if",
  condition: { ...condition, left: { literal: false } },
  steps,
});
const rows = (steps) => ({
  id: "rows",
  type: "repeat",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 2,
  steps,
});
const check = (steps, requireIds = true) =>
  validateRepeatGraph(steps, { requireIds, allowRuntimeRows: true });
test("canonical gRPC until admits nested fixed, IF and until ancestry without widening rows", () => {
  for (const nest of [
    (x) => x,
    (x) => gate([x]),
    (x) => repeat("fixed", [x]),
    (x) => until("inner", [x]),
  ]) {
    for (const enabled of [true, false]) {
      const steps = [until("outer", [nest({ ...leaf(), enabled })])];
      const before = structuredClone(steps);
      assert.equal(check(steps), true);
      assert.deepEqual(steps, before);
      assert.deepEqual(
        activePlanLeaves(steps).map((x) => x.id),
        enabled ? ["rpc"] : [],
      );
      for (const placement of [
        (x) => [rows(x)],
        (x) => [until("outside", [rows(x)])],
      ]) {
        assert.throws(() => check(placement(steps)), /运行时数据行循环/);
      }
    }
  }
});
test("until saved gRPC references remain provisional and frozen definitions are validated", () => {
  const steps = [
    until("outer", [{ ...leaf(), grpc: { definitionId: "saved" } }]),
  ];
  assert.equal(check(steps, false), true);
  assert.throws(() => check(steps), /冻结前/);
  steps[0].steps[0].grpc = { definition: {}, definitionId: "saved" };
  assert.throws(() => check(steps, false), /混合/);
});
test("until still rejects SSE, Socket.IO, malformed gRPC and wire aliases even when disabled", () => {
  for (const child of [
    { id: "sse", type: "protocol", protocol: { definition: { type: "sse" } } },
    {
      id: "alias",
      type: "protocol",
      protocol: { definition: { type: "grpc" } },
    },
    { id: "socket", type: "socketio", socketio: { definition: {} } },
    { ...leaf(), grpc: null },
  ])
    assert.throws(() =>
      check([until("outer", [gate([{ ...child, enabled: false }])])]),
    );
});
