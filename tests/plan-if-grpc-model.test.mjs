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
const rpc = () => ({
  id: "rpc",
  type: "grpc",
  grpc: {
    definition: { target: "grpc://127.0.0.1:1234" },
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
test("IF gRPC admits all supported nesting with false/disabled static definitions intact", () => {
  for (const nest of nestings)
    for (const enabled of [true, false]) {
      const steps = [nest({ ...rpc(), enabled })];
      const before = structuredClone(steps);
      assert.equal(check(steps), true);
      assert.deepEqual(
        planLeaves(steps).map((s) => s.id),
        ["rpc"],
      );
      assert.deepEqual(
        activePlanLeaves(steps).map((s) => s.id),
        enabled ? ["rpc"] : [],
      );
      assert.deepEqual(steps, before);
      steps[0].enabled = false;
      assert.equal(check(steps), true);
      assert.deepEqual(activePlanLeaves(steps), []);
    }
});
test("runtime-row gRPC admission intersects through IF and repeat with resolved disabled leaves", () => {
  for (const nest of nestings.slice(0, 3)) {
    const group = repeat([nest(rpc())]);
    group.id = "outer";
    delete group.count;
    group.rowsFrom = { scope: "runtime", name: "items" };
    group.maxRows = 2;
    for (const requireIds of [true, false])
      for (const reference of [true, false]) {
        const copy = structuredClone(group);
        copy.enabled = false;
        const child = planLeaves([copy])[0];
        child.enabled = false;
        if (reference) child.grpc = { definitionId: "saved-grpc" };
        if (reference && requireIds)
          assert.throws(() => check([copy], { requireIds }), /冻结前/);
        else assert.equal(check([copy], { requireIds }), true);
      }
  }
});

test("gRPC is not a wire protocol alias", () => {
  assert.throws(
    () =>
      check([
        gate([
          {
            id: "rpc",
            type: "protocol",
            protocol: { definition: { type: "grpc" } },
          },
        ]),
      ]),
    /条件组/,
  );
});
