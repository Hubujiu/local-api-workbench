import test from "node:test";
import assert from "node:assert/strict";
import { changePlanStructure } from "../public/plan-structure-editor.js";
import { snapshotPlan } from "../src/core.mjs";
const request = () => ({
  id: "request",
  name: "接口",
  method: "GET",
  url: "http://127.0.0.1:1/no-execution",
  beforeScript: "throw Error('never')",
  body: "\r\nbody\rnext",
  future: { opaque: [1, 2] },
});
const leaf = (id) => ({
  id,
  request: request(),
  liveRequestId: "existing-reference",
});
const group = () => ({
  id: "group",
  type: "repeat",
  count: 2,
  steps: [leaf("a"), leaf("b")],
});
const plan = () => ({
  id: "plan",
  steps: [group(), leaf("sibling")],
  future: { keep: true },
});
const ids = () => {
  let i = 0;
  return () => `fresh-${++i}`;
};
for (const kind of ["http", "repeat", "if"])
  test(`add ${kind} produces inert explicit snapshot without modifying input`, () => {
    const p = plan(),
      original = structuredClone(p),
      source = request(),
      before = structuredClone(source);
    const out = changePlanStructure(
      p,
      { action: "add", parentPath: [0], kind, request: source },
      ids(),
    );
    assert.deepEqual(p, original);
    assert.deepEqual(source, before);
    assert.deepEqual(out.steps[1], original.steps[1]);
    assert.deepEqual(out.steps[0].steps.slice(0, 2), original.steps[0].steps);
    const added = out.steps[0].steps[2],
      child = kind === "http" ? added : added.steps[0];
    assert.equal(child.liveRequestId, undefined);
    assert.equal(child.request.beforeScript, "");
    assert.equal(child.request.body, source.body);
    assert.deepEqual(child.request.future, source.future);
    assert.deepEqual(out.future, p.future);
    if (kind === "repeat") assert.equal(added.count, 1);
    if (kind === "if")
      assert.deepEqual(added.condition, {
        op: "eq",
        left: { literal: true },
        right: { literal: true },
      });
  });
test("same-parent reorder preserves all opaque fields and identities; boundary moves are no-ops", () => {
  const p = plan();
  p.steps[0].future = { multiline: "\r\nuntouched\r" };
  const swapped = changePlanStructure(p, {
    action: "down",
    parentPath: [0],
    index: 0,
  });
  assert.deepEqual(swapped.steps[0].steps, [...p.steps[0].steps].reverse());
  assert.deepEqual(swapped.steps[0].future, p.steps[0].future);
  assert.deepEqual(
    changePlanStructure(p, { action: "up", parentPath: [0], index: 0 }),
    p,
  );
  assert.deepEqual(
    changePlanStructure(p, { action: "down", parentPath: [0], index: 1 }),
    p,
  );
});
test("last child cannot be removed but whole group can be removed from parent", () => {
  const p = plan();
  p.steps[0].steps.pop();
  const before = structuredClone(p);
  assert.throws(
    () =>
      changePlanStructure(p, { action: "remove", parentPath: [0], index: 0 }),
    /至少保留/,
  );
  assert.deepEqual(p, before);
  const out = changePlanStructure(p, {
    action: "remove",
    parentPath: [],
    index: 0,
  });
  assert.deepEqual(out.steps, [p.steps[1]]);
});
for (const change of [
  { action: "remove", parentPath: [1], index: 0 },
  { action: "remove", parentPath: [-1], index: 0 },
  { action: "remove", parentPath: ["0"], index: 0 },
  { action: "remove", parentPath: [0], index: 2 },
  { action: "remove", parentPath: [0], index: 0.5 },
  { action: "teleport", parentPath: [0], index: 0 },
])
  test(`invalid structural path/action rejects atomically ${JSON.stringify(change)}`, () => {
    const p = plan(),
      before = structuredClone(p);
    assert.throws(() => changePlanStructure(p, change));
    assert.deepEqual(p, before);
  });
test("identity collisions with any plan sibling and malformed allocated identities reject", () => {
  for (const id of [
    "sibling",
    "group",
    "__proto__",
    "",
    null,
    "a".repeat(201),
  ]) {
    const p = plan(),
      before = structuredClone(p);
    assert.throws(
      () =>
        changePlanStructure(
          p,
          { action: "add", parentPath: [0], request: request() },
          () => id,
        ),
      /ID/,
    );
    assert.deepEqual(p, before);
  }
});
test("four control layers admitted, fifth rejected even disabled", () => {
  const p = { steps: [leaf("l")] };
  for (let i = 0; i < 4; i++)
    p.steps = [{ id: `g${i}`, type: "repeat", count: 1, steps: p.steps }];
  const before = structuredClone(p);
  assert.doesNotThrow(() => snapshotPlan(p));
  assert.throws(
    () =>
      changePlanStructure(
        p,
        {
          action: "add",
          parentPath: [0, 0, 0, 0],
          kind: "if",
          request: request(),
        },
        ids(),
      ),
    /最多4层/,
  );
  assert.deepEqual(p, before);
});
test("200 siblings accepted, 201st rejected without truncating existing steps", () => {
  const p = { steps: Array.from({ length: 200 }, (_, i) => leaf(`l${i}`)) },
    before = structuredClone(p);
  assert.throws(
    () => changePlanStructure(p, { action: "add", request: request() }, ids()),
    /200/,
  );
  assert.deepEqual(p, before);
});
test("local structural edits preserve unknown group fields for authoritative rejection rather than strip", () => {
  const p = plan();
  p.steps[0].future = { keep: "yes" };
  const out = changePlanStructure(p, {
    action: "up",
    parentPath: [0],
    index: 1,
  });
  assert.deepEqual(out.steps[0].future, p.steps[0].future);
  assert.throws(() => snapshotPlan(out));
});
test("expanded budget remains a whole-plan server validation requirement, not per-node UI promise", () => {
  const p = {
    steps: [
      {
        id: "g",
        type: "repeat",
        count: 100,
        enabled: false,
        steps: [leaf("a"), leaf("b")],
      },
    ],
  };
  assert.doesNotThrow(() => snapshotPlan(p));
  const out = changePlanStructure(
    p,
    { action: "add", parentPath: [0], request: request() },
    ids(),
  );
  assert.throws(() => snapshotPlan(out), /200/);
  assert.equal(p.steps[0].steps.length, 2);
});

import {
  bindPlanStructureEditor,
  planStructureEditor,
} from "../public/plan-structure-editor.js";
function harness({ preview = async () => {}, assertCurrent = () => {} } = {}) {
  let click;
  const fields = {
    innerHTML: "",
    disabled: false,
    addEventListener(type, fn) {
      click = fn;
    },
    contains: (button) => button.current !== false,
    querySelector: (selector) => ({
      value: selector.includes("kind") ? "http" : "request",
    }),
  };
  const error = { hidden: true, textContent: "" },
    json = { value: "" };
  const container = {
    isConnected: true,
    querySelector: (key) =>
      ({
        "[data-structure-fields]": fields,
        "[data-structure-error]": error,
        "[data-structure-json]": json,
      })[key],
  };
  const p = plan(),
    before = structuredClone(p);
  const collect = bindPlanStructureEditor(container, p, {
    requests: [request()],
    preview,
    assertCurrent,
  });
  const press = (action, path = "0", index = "0") =>
    click({
      target: {
        closest: () => ({
          disabled: false,
          dataset: { structureAction: action, parent: path, index },
        }),
      },
    });
  return { fields, error, json, container, p, before, collect, press };
}
test("precheck rejection preserves the complete draft and reports exact reason", async () => {
  const h = harness({
    preview: async () => {
      throw Error("完整计划展开最多200步");
    },
  });
  await h.press("remove");
  assert.deepEqual(h.collect(), h.before);
  assert.deepEqual(h.p, h.before);
  assert.equal(h.error.textContent, "完整计划展开最多200步");
  assert.equal(h.error.hidden, false);
  assert.deepEqual(JSON.parse(h.json.value), h.before);
});
test("pending preview blocks submission and repeated clicks; success changes only isolated draft", async () => {
  let release,
    calls = 0;
  const wait = new Promise((r) => (release = r));
  const h = harness({
    preview: async () => {
      calls++;
      await wait;
    },
  });
  const run = h.press("remove");
  assert.throws(h.collect, /预检尚未/);
  assert.equal(h.fields.disabled, true);
  await h.press("remove");
  assert.equal(calls, 1);
  release();
  await run;
  assert.equal(h.collect().steps[0].steps.length, 1);
  assert.deepEqual(h.p, h.before);
  assert.equal(h.fields.disabled, false);
});
test("late preview after owner/version change cannot apply candidate", async () => {
  let current = true,
    release;
  const wait = new Promise((r) => (release = r));
  const h = harness({
    preview: () => wait,
    assertCurrent: () => {
      if (!current) throw Error("owner changed");
    },
  });
  const run = h.press("remove");
  current = false;
  release();
  await run;
  current = true;
  assert.deepEqual(h.collect(), h.before);
  assert.equal(h.error.textContent, "owner changed");
});
test("late preview after detached dialog never updates the prior draft", async () => {
  let release;
  const wait = new Promise((r) => (release = r));
  const h = harness({ preview: () => wait });
  const run = h.press("remove");
  h.container.isConnected = false;
  release();
  await run;
  assert.deepEqual(h.collect(), h.before);
  assert.equal(h.error.hidden, true);
});
test("unrelated multiline and unknown request fields survive structural rerender and JSON copy", async () => {
  const h = harness();
  await h.press("down");
  const p = h.collect();
  assert.equal(p.steps[0].steps[1].request.body, "\r\nbody\rnext");
  assert.deepEqual(p.steps[0].steps[1].request.future, { opaque: [1, 2] });
  assert.deepEqual(JSON.parse(h.json.value), p);
  assert.match(planStructureEditor(), /不执行请求/);
});
