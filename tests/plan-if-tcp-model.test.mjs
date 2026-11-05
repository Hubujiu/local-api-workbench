// Pure canonical graph admission only: no runtime, transport, server or VM imports.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRepeatGraph,
  activePlanLeaves,
  planLeaves,
} from "../src/plan-repeat.mjs";

const condition = (matched = true) => ({
  left: { literal: matched },
  op: "eq",
  right: { literal: true },
});
const http = () => ({
  id: "http",
  request: { url: "https://example.invalid" },
});
const tcp = () => ({
  id: "tcp",
  type: "protocol",
  protocol: {
    definition: { type: "tcp", url: "127.0.0.1", port: 1234 },
    message: "hello",
  },
});
const gate = (steps, overrides = {}) => ({
  id: "gate",
  type: "if",
  condition: condition(),
  steps,
  ...overrides,
});
const fixed = (steps, overrides = {}) => ({
  id: "fixed",
  type: "repeat",
  count: 2,
  steps,
  ...overrides,
});
const check = (steps, options = {}) =>
  validateRepeatGraph(steps, { requireIds: true, ...options });
const nestings = [
  (child) => gate([child]),
  (child) => gate([fixed([child])]),
  (child) => fixed([gate([child])]),
  (child) => gate([fixed([gate([child], { id: "inner" })])]),
];

test("canonical IF accepts HTTP and TCP through nested IF and fixed repeats without mutation", () => {
  for (const nest of nestings) {
    const steps = [nest(tcp()), http()];
    const before = structuredClone(steps);
    assert.equal(check(steps), true);
    assert.deepEqual(
      planLeaves(steps).map((step) => step.id),
      ["tcp", "http"],
    );
    assert.deepEqual(
      activePlanLeaves(steps).map((step) => step.id),
      ["tcp", "http"],
    );
    assert.deepEqual(steps, before);
    assert.equal(check([nest(http())]), true);
  }
});

test("canonical IF rejects unsupported protocols and non-HTTP leaf through fixed repeats", () => {
  for (const nest of nestings) {
    for (const type of ["sse", "grpc", "socketio", "unknown"]) {
      const child = tcp();
      child.protocol.definition.type = type;
      assert.throws(() => check([nest(child)]), /条件组仅支持HTTP或TCP/);
    }
    for (const type of ["grpc", "socketio", "database", "unknown"]) {
      assert.throws(
        () => check([nest({ id: "other", type, [type]: { definition: {} } })]),
        /条件组仅支持HTTP或TCP/,
      );
    }
  }
  // The narrower IF rule must not leak to an unrelated fixed-repeat sibling.
  const wire = tcp();
  wire.id = "wire";
  wire.protocol.definition.type = "websocket";
  assert.equal(check([gate([tcp()]), fixed([wire])]), true);
});

test("false and disabled IF graphs still validate leaf types and TCP structure", () => {
  for (const overrides of [
    { condition: condition(false) },
    { enabled: false },
  ]) {
    const valid = [gate([tcp()], overrides)];
    assert.equal(check(valid), true);
    if (overrides.enabled === false)
      assert.deepEqual(activePlanLeaves(valid), []);
    for (const mutate of [
      (child) => {
        child.protocol.definition.type = "sse";
      },
      (child) => {
        child.extra = true;
      },
      (child) => {
        child.protocol.definition = null;
      },
      (child) => {
        child.id = "gate";
      },
    ]) {
      const child = tcp();
      child.enabled = false;
      mutate(child);
      assert.throws(() => check([gate([fixed([child])], overrides)]));
    }
  }
});

test("IF protocol references are provisional and frozen graphs must resolve to TCP or WebSocket", () => {
  for (const nest of nestings) {
    const child = tcp();
    child.protocol = { definitionId: "saved-protocol" };
    assert.equal(validateRepeatGraph([nest(child)]), true);
    assert.throws(() => check([nest(child)]));
    for (const definitionId of ["", " ", null, 12]) {
      assert.throws(() =>
        validateRepeatGraph([nest({ ...child, protocol: { definitionId } })]),
      );
    }
    for (const type of ["tcp", "websocket", "sse"]) {
      const resolved = tcp();
      resolved.protocol.definition.type = type;
      if (["tcp", "websocket"].includes(type))
        assert.equal(check([nest(resolved)]), true);
      else
        assert.throws(() => check([nest(resolved)]), /条件组仅支持HTTP或TCP/);
    }
    child.protocol.definition = tcp().protocol.definition;
    assert.throws(() => validateRepeatGraph([nest(child)]), /混合/);
  }
});

test("repeat-until remains HTTP-only across IF and fixed-repeat ancestry, even false or disabled", () => {
  const wrappers = [
    (child) => fixed([gate([child])], { untilCondition: condition() }),
    (child) => gate([fixed([child], { untilCondition: condition() })]),
    (child) =>
      fixed(
        [
          gate([fixed([child], { id: "inner" })], {
            condition: condition(false),
          }),
        ],
        { untilCondition: condition() },
      ),
  ];
  for (const wrap of wrappers) {
    assert.equal(check([wrap(http())]), true);
    for (const child of [
      tcp(),
      { ...tcp(), enabled: false },
      { id: "ref", type: "protocol", protocol: { definitionId: "saved-tcp" } },
    ]) {
      const group = wrap(child);
      group.enabled = false;
      for (const requireIds of [false, true]) {
        assert.throws(
          () => check([group], { requireIds }),
          /提前结束循环.*仅支持HTTP/,
        );
      }
    }
  }
});

test("runtime rows remain HTTP-only through false IF and fixed repeats before and after freezing", () => {
  const rows = (steps) => ({
    id: "rows",
    type: "repeat",
    rowsFrom: { scope: "runtime", name: "items" },
    maxRows: 2,
    steps,
  });
  const wrappers = [
    (child) => rows([gate([child])]),
    (child) => gate([rows([fixed([child])])]),
    (child) => rows([gate([fixed([child])], { condition: condition(false) })]),
  ];
  for (const wrap of wrappers) {
    assert.equal(check([wrap(http())], { allowRuntimeRows: true }), true);
    for (const child of [
      tcp(),
      { id: "ref", type: "protocol", protocol: { definitionId: "saved-tcp" } },
    ]) {
      const group = wrap({ ...child, enabled: false });
      group.enabled = false;
      for (const requireIds of [false, true]) {
        assert.throws(
          () => check([group], { requireIds, allowRuntimeRows: true }),
          /运行时数据行循环.*仅支持HTTP/,
        );
      }
    }
  }
});
