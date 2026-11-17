import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRepeatGraph,
  planLeaves,
  activePlanLeaves,
  mapPlanLeaves,
  planOccurrences,
  activePlanStepCount,
} from "../src/plan-repeat.mjs";
const leaf = (id) => ({ id, request: { url: "https://example.invalid/" } });
const group = (id, steps, count = 2) => ({ type: "repeat", id, count, steps });
const graph = () => [
  group("outer", [
    leaf("before"),
    group("inner", [leaf("child")]),
    leaf("after"),
  ]),
];

test("nested occurrences are serial, injective and preserve legacy single-layer identity bytes", () => {
  const steps = graph(),
    before = structuredClone(steps);
  assert.equal(validateRepeatGraph(steps, { requireIds: true }), true);
  const occurrences = planOccurrences(steps);
  assert.deepEqual(
    occurrences.map(({ step }) => step.id),
    ["before", "child", "child", "after", "before", "child", "child", "after"],
  );
  assert.equal(activePlanStepCount({ steps }), 8);
  assert.deepEqual(occurrences[0].repeat, {
    groupId: "outer",
    childId: "before",
    iteration: 0,
    occurrenceId: '["outer","before",0]',
  });
  assert.deepEqual(occurrences[1].repeat, {
    groupId: "inner",
    childId: "child",
    iteration: 0,
    occurrenceId: '[[["outer",0],["inner",0]],"child"]',
    path: [
      { groupId: "outer", iteration: 0 },
      { groupId: "inner", iteration: 0 },
    ],
  });
  assert.equal(
    new Set(occurrences.map(({ repeat }) => repeat.occurrenceId)).size,
    8,
  );
  assert.equal(occurrences[1].step, steps[0].steps[1].steps[0]);
  occurrences[1].repeat.path[0].iteration = 99;
  assert.equal(occurrences[2].repeat.path[0].iteration, 0);
  assert.deepEqual(steps, before);
});

test("recursive definition helpers map exactly once and disabled ancestors suppress only active leaves", () => {
  const steps = graph();
  steps[0].steps[1].enabled = false;
  assert.deepEqual(
    planLeaves(steps).map((s) => s.id),
    ["before", "child", "after"],
  );
  assert.deepEqual(
    activePlanLeaves(steps).map((s) => s.id),
    ["before", "after"],
  );
  const visited = [];
  const mapped = mapPlanLeaves(steps, (step) => {
    visited.push(step.id);
    return { ...step, name: step.id };
  });
  assert.deepEqual(visited, ["before", "child", "after"]);
  assert.equal(mapped[0].steps[1].steps[0].name, "child");
  assert.equal(steps[0].steps[1].steps[0].name, undefined);
  steps[0].enabled = false;
  assert.deepEqual(activePlanLeaves(steps), []);
  assert.deepEqual(planOccurrences(steps), []);
});

test("depth four accepted, depth five rejected even disabled; global IDs include every group and leaf", () => {
  let steps = [leaf("leaf")];
  for (let i = 0; i < 4; i++) steps = [group("g" + i, steps, 1)];
  assert.equal(validateRepeatGraph(steps, { requireIds: true }), true);
  assert.equal(planOccurrences(steps)[0].repeat.path.length, 4);
  const tooDeep = [{ ...group("g4", steps, 1), enabled: false }];
  assert.throws(() => validateRepeatGraph(tooDeep), /4层/);
  for (const id of ["outer", "inner", "before"]) {
    const bad = graph();
    bad[0].steps[1].steps[0].id = id;
    bad[0].enabled = false;
    assert.throws(() => validateRepeatGraph(bad), /重复/);
  }
});

test("nested potential count products and logical bytes include disabled descendants", () => {
  const steps = [group("outer", [group("inner", [leaf("leaf")], 100)], 2)];
  steps[0].enabled = false;
  assert.equal(validateRepeatGraph(steps), true);
  steps[0].count = 3;
  assert.throws(() => validateRepeatGraph(steps), /200/);
  steps[0].count = 2;
  steps[0].steps[0].count = 101;
  assert.throws(() => validateRepeatGraph(steps), /100/);
  steps[0].steps[0].count = 100;
  steps[0].steps[0].steps[0].request.body = "x".repeat(22000);
  assert.throws(() => validateRepeatGraph(steps), /4MiB/);
});

test("deep invalid data and wrappers reject before traversal, including disabled groups", () => {
  for (const change of [
    (s) => {
      s[0].steps[1].extra = true;
    },
    (s) => {
      s[0].steps[1].steps[0].enabled = "false";
    },
    (s) => {
      s[0].steps[1].steps[0].request.url = "";
    },
    (s) => {
      s[0].steps[1].steps = s;
    },
    (s) => {
      Object.defineProperty(s[0].steps[1].steps[0], "request", {
        enumerable: true,
        get() {
          throw Error("must not invoke");
        },
      });
    },
  ]) {
    const steps = graph();
    steps[0].enabled = false;
    change(steps);
    assert.throws(() => validateRepeatGraph(steps), /循环/);
  }
});

test("JSON tuple identities remain distinct with separator and JSON-like opaque IDs", () => {
  const steps = [group('["x",0]', [group("a,b", [leaf('c"d')])])];
  validateRepeatGraph(steps, { requireIds: true });
  const occurrences = planOccurrences(steps);
  assert.equal(new Set(occurrences.map((o) => o.repeat.occurrenceId)).size, 4);
  for (const { repeat } of occurrences) {
    const parsed = JSON.parse(repeat.occurrenceId);
    assert.ok(Array.isArray(parsed[0]));
    assert.equal(parsed[1], 'c"d');
  }
});
