// Pure graph policy tests. Real peers are covered by the workflow suite.
import test from "node:test";
import assert from "node:assert/strict";
import { validateRepeatGraph, activePlanLeaves } from "../src/plan-repeat.mjs";
const condition = {
  left: { literal: true },
  op: "eq",
  right: { literal: true },
};
const leaf = () => ({
  id: "socket",
  type: "socketio",
  socketio: { definition: {} },
});
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

test("Socket.IO until admits independent leaves under fixed, IF and until ancestry without mutating definitions", () => {
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
        enabled ? ["socket"] : [],
      );
      steps[0].enabled = false;
      assert.equal(check(steps), true);
      assert.deepEqual(activePlanLeaves(steps), []);
    }
  }
});

test("Socket.IO until cannot broaden runtime-row ancestors or descendants, including disabled and provisional leaves", () => {
  for (const nest of [
    (x) => [rows([until("until", [x])])],
    (x) => [until("until", [rows([x])])],
    (x) => [until("until", [gate([rows([x])])])],
  ]) {
    for (const enabled of [true, false])
      for (const reference of [true, false])
        for (const requireIds of [true, false]) {
          const child = { ...leaf(), enabled };
          if (reference) child.socketio = { definitionId: "saved" };
          const steps = nest(child);
          steps[0].enabled = enabled;
          assert.throws(() => check(steps, requireIds), /运行时数据行循环/);
        }
  }
});

test("Socket.IO until saved references remain provisional until freezing and reject mixed definitions", () => {
  const steps = [
    until("outer", [{ ...leaf(), socketio: { definitionId: "saved" } }]),
  ];
  assert.equal(check(steps, false), true);
  assert.throws(() => check(steps), /冻结前/);
  steps[0].steps[0].socketio.definition = {};
  assert.throws(() => check(steps, false), /混合/);
});

test("Socket.IO until rejects other protocols, aliases, malformed envelopes and scripts even when disabled", () => {
  for (const child of [
    { id: "sse", type: "protocol", protocol: { definition: { type: "sse" } } },
    {
      id: "alias",
      type: "protocol",
      protocol: { definition: { type: "socketio" } },
    },
    { id: "db", type: "database" },
    { ...leaf(), socketio: null },
    { ...leaf(), socketioScripts: { before: "" } },
    { ...leaf(), grpcScripts: { before: "" } },
    { ...leaf(), protocolScripts: { before: "" } },
    { ...leaf(), scripts: {} },
  ])
    assert.throws(() =>
      check([until("outer", [gate([{ ...child, enabled: false }])])]),
    );
});

test("Socket.IO until preserves count, delay, expanded request, decision, depth and same-group rows limits", () => {
  for (const extra of [
    { count: 101 },
    { intervalMs: 10001 },
    { count: 100, intervalMs: 1000 },
    {
      count: 100,
      steps: [repeat("inner", [leaf()]), { ...leaf(), id: "other" }],
    },
    { count: 100, steps: [{ ...until("inner", [leaf()]), count: 2 }] },
    { rows: [{}] },
  ])
    assert.throws(() => check([{ ...until("outer", [leaf()]), ...extra }]));
  let nested = leaf();
  for (let i = 0; i < 5; i++)
    nested = { ...until(`depth-${i}`, [nested]), count: 1 };
  assert.throws(() => check([nested]), /4层/);
  assert.throws(() => check([until("outer", [leaf(), leaf()])]), /重复/);
});
