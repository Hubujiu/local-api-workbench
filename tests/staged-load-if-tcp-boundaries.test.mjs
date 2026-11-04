// Cross-feature boundary coverage: staged runtime-row support must not widen TCP execution.
import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareStagedLoad,
  runStagedLoad,
  buildLoadSchedule,
} from "../src/staged-load-plan.mjs";
import { validateRepeatGraph, activePlanLeaves } from "../src/plan-repeat.mjs";
const input = {
  initialVUs: 1,
  stages: [{ durationSeconds: 1, targetVUs: 1 }],
  maxIterations: 1,
};
const http = () => ({ id: "http", request: { url: "http://127.0.0.1:1" } });
const tcp = () => ({
  id: "tcp",
  type: "protocol",
  protocol: {
    definition: { type: "tcp", url: "127.0.0.1", port: 1 },
    message: "hello",
  },
});
const gate = (steps, matched = true) => ({
  id: "gate",
  type: "if",
  condition: { left: { literal: matched }, op: "eq", right: { literal: true } },
  steps,
});
const rows = (steps) => ({
  id: "rows",
  type: "repeat",
  rowsFrom: { scope: "runtime", name: "items" },
  maxRows: 2,
  steps,
});
const fixed = (steps) => ({ id: "fixed", type: "repeat", count: 2, steps });
const noRead = new Proxy(
  {},
  {
    get() {
      assert.fail("project read before static admission");
    },
  },
);
for (const matched of [true, false])
  for (const [nesting, nest] of [
    ["IF", (x) => gate([x], matched)],
    ["IF/fixed", (x) => gate([fixed([x])], matched)],
    ["fixed/IF", (x) => fixed([gate([x], matched)])],
  ]) {
    test(`staged rejects enabled IF TCP before project/scopes/transport, condition=${matched}, nesting=${nesting}`, async () => {
      const snapshot = { steps: [http(), nest(tcp())] };
      assert.equal(
        validateRepeatGraph(snapshot.steps, { requireIds: true }),
        true,
      );
      assert.throws(() => prepareStagedLoad(noRead, snapshot, input), /HTTP/);
      await assert.rejects(
        runStagedLoad(noRead, { snapshot, schedule: buildLoadSchedule(input) }),
        /HTTP/,
      );
    });
  }
for (const enabled of [true, false])
  for (const matched of [true, false])
    for (const [nesting, nest] of [
      ["rows/IF", (x) => rows([gate([x], matched)])],
      ["IF/rows/fixed", (x) => gate([rows([fixed([x])])], matched)],
    ]) {
      test(`runtime rows never gains IF TCP, enabled=${enabled}, condition=${matched}, nesting=${nesting}`, async () => {
        const child = tcp();
        child.enabled = enabled;
        const snapshot = { steps: [http(), nest(child)] };
        assert.throws(
          () =>
            validateRepeatGraph(snapshot.steps, {
              requireIds: true,
              allowRuntimeRows: true,
            }),
          /运行时数据行循环.*仅支持HTTP/,
        );
        assert.throws(
          () => prepareStagedLoad(noRead, snapshot, input),
          /运行时数据行循环.*仅支持HTTP/,
        );
        await assert.rejects(
          runStagedLoad(noRead, {
            snapshot,
            schedule: buildLoadSchedule(input),
          }),
          /运行时数据行循环.*仅支持HTTP/,
        );
      });
    }
test("disabled standalone IF TCP retains staged admission compatibility alongside HTTP", () => {
  const project = {
    environments: [{ id: "env", name: "env", variables: {} }],
    settings: {},
  };
  const disabled = gate([tcp()]);
  disabled.enabled = false;
  const prepared = prepareStagedLoad(
    project,
    { steps: [http(), disabled] },
    input,
  );
  assert.equal(prepared.snapshot.steps[1].enabled, false);
  assert.deepEqual(
    activePlanLeaves(prepared.snapshot.steps, { allowRuntimeRows: true }).map(
      (step) => step.id,
    ),
    ["http"],
  );
});
