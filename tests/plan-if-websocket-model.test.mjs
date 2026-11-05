// Pure capability intersection tests: no runtime, transport or application imports.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRepeatGraph,
  activePlanLeaves,
  planLeaves,
} from "../src/plan-repeat.mjs";
const condition = {
  left: { literal: false },
  op: "eq",
  right: { literal: true },
};
const wire = (type = "websocket") => ({
  id: "wire",
  type: "protocol",
  protocol: {
    definition: { type, url: "ws://127.0.0.1:1234" },
    message: "hello",
  },
});
const gate = (steps) => ({ id: "gate", type: "if", condition, steps });
const repeat = (steps) => ({ id: "repeat", type: "repeat", count: 2, steps });
const nestings = [
  (child) => gate([child]),
  (child) => gate([repeat([child])]),
  (child) => repeat([gate([child])]),
  (child) => gate([repeat([{ ...gate([child]), id: "inner" }])]),
];
const check = (steps, options = {}) =>
  validateRepeatGraph(steps, {
    requireIds: true,
    allowRuntimeRows: true,
    ...options,
  });
test("IF WebSocket admits all supported nesting with false/disabled static definitions intact", () => {
  for (const nest of nestings)
    for (const enabled of [true, false]) {
      const steps = [nest({ ...wire(), enabled })];
      const before = structuredClone(steps);
      assert.equal(check(steps), true);
      assert.deepEqual(
        planLeaves(steps).map((s) => s.id),
        ["wire"],
      );
      assert.deepEqual(
        activePlanLeaves(steps).map((s) => s.id),
        enabled ? ["wire"] : [],
      );
      assert.deepEqual(steps, before);
      steps[0].enabled = false;
      assert.equal(check(steps), true);
      assert.deepEqual(activePlanLeaves(steps), []);
    }
});
test("all restrictive ancestors intersect through IF and repeat, including unresolved and disabled leaves", () => {
  for (const restriction of ["until", "rows"])
    for (const nest of nestings.slice(0, 3)) {
      const group = repeat([nest(wire())]);
      group.id = "outer";
      if (restriction === "until") group.untilCondition = condition;
      else {
        delete group.count;
        group.rowsFrom = { scope: "runtime", name: "items" };
        group.maxRows = 2;
      }
      for (const requireIds of [true, false])
        for (const reference of [true, false]) {
          const copy = structuredClone(group);
          copy.enabled = false;
          const child = planLeaves([copy])[0];
          child.enabled = false;
          if (reference) child.protocol = { definitionId: "saved-wire" };
          assert.throws(
            () => check([copy], { requireIds }),
            restriction === "until"
              ? /提前结束循环.*仅支持HTTP/
              : /运行时数据行循环.*仅支持HTTP/,
          );
        }
    }
});
test("unrelated restricted siblings do not narrow WebSocket IF or broaden unsupported IF", () => {
  const until = {
    ...repeat([{ id: "http", request: { url: "http://localhost" } }]),
    untilCondition: condition,
  };
  assert.equal(check([until, gate([wire()])]), true);
  assert.throws(
    () => check([until, gate([wire("unknown")])]),
    /条件组仅支持HTTP/,
  );
});
test("false/disabled WebSocket nodes still reject malformed graph envelopes and frozen references", () => {
  for (const mutate of [
    (s) => {
      s.extra = 1;
    },
    (s) => {
      s.protocol.definition = null;
    },
    (s) => {
      s.protocol = { definitionId: "saved" };
    },
    (s) => {
      s.protocol.definitionId = "saved";
    },
    (s) => {
      s.id = "gate";
    },
    (s) => {
      s.protocol.definition.type = "unknown";
    },
  ]) {
    const child = wire();
    child.enabled = false;
    mutate(child);
    const group = gate([child]);
    group.enabled = false;
    assert.throws(() => check([group]));
  }
});
