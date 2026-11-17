import test from "node:test";
import assert from "node:assert/strict";
import { snapshotPlan } from "../src/core.mjs";
import { validatePlanCondition } from "../src/plan-condition.mjs";
import {
  applyVisualControls,
  visualControlValues,
  visualCondition,
  controlEditor,
  conditionOps,
} from "../public/plan-control-editor.js";
const group = () => ({
  id: "g",
  type: "repeat",
  count: 2,
  steps: [
    {
      id: "if",
      type: "if",
      condition: {
        op: "eq",
        left: { literal: true },
        right: { literal: true },
      },
      steps: [
        {
          id: "leaf",
          request: { method: "GET", url: "http://127.0.0.1:1/no-call" },
        },
      ],
    },
  ],
});
test("no-op visual collection preserves agent extensions, absent fields, IDs and frozen nested graph", () => {
  const raw = group();
  raw.agentFuture = { opaque: [1, { x: "preserve" }] };
  raw.steps[0].steps[0].future = { custom: true };
  const before = structuredClone(raw);
  assert.deepEqual(applyVisualControls(raw, visualControlValues(raw)), before);
  assert.deepEqual(raw, before);
  const frozen = snapshotPlan({ steps: [group()] }).steps[0];
  assert.deepEqual(
    applyVisualControls(frozen, visualControlValues(frozen)),
    frozen,
  );
});
test("explicit patches only change selected count, interval, nested name and enabled status", () => {
  const raw = group();
  raw.future = { payload: "keep" };
  const before = structuredClone(raw);
  const out = applyVisualControls(raw, {
    "root:count": "3",
    "root:intervalMs": "50",
    "0:name": "Human branch",
    "0.0:enabled": false,
  });
  assert.equal(out.count, 3);
  assert.equal(out.intervalMs, 50);
  assert.equal(out.steps[0].name, "Human branch");
  assert.equal(out.steps[0].steps[0].enabled, false);
  assert.deepEqual(out.future, raw.future);
  assert.deepEqual(
    out.steps[0].steps[0].request,
    raw.steps[0].steps[0].request,
  );
  assert.deepEqual(raw, before);
  delete out.future;
  assert.doesNotThrow(() => snapshotPlan({ steps: [out] }));
});
for (const op of Object.keys(conditionOps))
  test(`visual ${op} writes the exact backend condition contract`, () => {
    const raw = group();
    const text = ["contains", "notContains"].includes(op);
    const out = applyVisualControls(raw, {
      "0:op": op,
      "0:left.kind": text ? "text" : "number",
      "0:left.value": text ? "prefix-tail" : "3",
      "0:right.kind": text ? "text" : "number",
      "0:right.value": text ? "tail" : "2",
    });
    assert.doesNotThrow(() => validatePlanCondition(out.steps[0].condition));
    assert.doesNotThrow(() => snapshotPlan({ steps: [out] }));
  });
test("explicit variable scopes and boolean/null literals retain their types", () => {
  for (const scope of ["globals", "environment", "runtime", "iterationData"]) {
    const out = applyVisualControls(group(), {
      "0:left.kind": scope,
      "0:left.value": "ready",
      "0:right.kind": "false",
    });
    assert.deepEqual(out.steps[0].condition.left, { scope, name: "ready" });
    assert.deepEqual(out.steps[0].condition.right, { literal: false });
    validatePlanCondition(out.steps[0].condition);
  }
  const out = applyVisualControls(group(), {
    "0:left.kind": "null",
    "0:right.kind": "null",
  });
  assert.equal(out.steps[0].condition.left.literal, null);
});
test("repeat until is only added or removed by explicit toggle; untouched children survive", () => {
  const raw = group();
  const out = applyVisualControls(raw, { "root:untilEnabled": true });
  assert.deepEqual(out.untilCondition, {
    op: "eq",
    left: { literal: true },
    right: { literal: true },
  });
  assert.deepEqual(out.steps, raw.steps);
  snapshotPlan({ steps: [out] });
  const removed = applyVisualControls(out, { "root:untilEnabled": false });
  assert.equal(Object.hasOwn(removed, "untilCondition"), false);
  assert.deepEqual(removed, raw);
});
test("unsupported condition or data-row fields are preserved rather than projected", () => {
  const raw = group();
  raw.steps[0].condition.agentRule = { version: 2 };
  raw.rows = [{ key: 1 }, { key: 2 }];
  assert.equal(visualCondition(raw.steps[0].condition), null);
  assert.equal(Object.hasOwn(visualControlValues(raw), "root:count"), false);
  const edited = applyVisualControls(raw, {
    "root:name": "Renamed",
    "0:op": "neq",
    "root:count": "8",
  });
  assert.equal(edited.count, 2);
  assert.deepEqual(edited.steps, raw.steps);
  assert.deepEqual(edited.rows, raw.rows);
  assert.match(controlEditor(raw), /当前表单不支持/);
  const runtime = {
    ...group(),
    rowsFrom: { scope: "runtime", name: "rows" },
    maxRows: 10,
    maxRowBytes: 1234,
  };
  delete runtime.count;
  const next = applyVisualControls(runtime, { "root:intervalMs": "20" });
  assert.deepEqual(next.rowsFrom, runtime.rowsFrom);
  assert.equal(next.maxRows, 10);
  assert.equal(Object.hasOwn(next, "count"), false);
});
test("invalid numeric/type/source edits reject without changing source", () => {
  for (const patch of [
    { "root:count": "0" },
    { "root:count": "101" },
    { "root:count": "1.5" },
    { "root:intervalMs": "-1" },
    { "root:intervalMs": "10001" },
    { "0:left.kind": "number", "0:left.value": "" },
    { "0:left.kind": "number", "0:left.value": "1e999" },
    {
      "0:left.kind": "text",
      "0:left.value": "3",
      "0:right.kind": "number",
      "0:right.value": "3",
    },
    { "0:left.kind": "runtime", "0:left.value": "__proto__" },
    { "0:left.kind": "text", "0:left.value": "" },
    { "0:op": "contains" },
  ]) {
    const raw = group(),
      before = structuredClone(raw);
    assert.throws(() => applyVisualControls(raw, patch));
    assert.deepEqual(raw, before);
  }
});
test("HTML escapes agent-controlled names and condition text; no structural edit is advertised", () => {
  const raw = group();
  raw.name = "<img src=x onerror=alert(1)>";
  raw.steps[0].condition = {
    op: "eq",
    left: { literal: "</textarea><script>x</script>" },
    right: { literal: "safe" },
  };
  const html = controlEditor(raw);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;img/);
  assert.match(html, /尚不支持可视化新建/);
});

test("mode switches collect explicit edits, reject malformed JSON and preserve the active draft", async () => {
  const { bindControlEditor } = await import(
    "../public/plan-control-editor.js"
  );
  const raw = group(),
    original = structuredClone(raw),
    listeners = {};
  const controls = Object.entries(visualControlValues(raw)).map(
    ([controlKey, value]) => ({
      dataset: { controlKey },
      type: typeof value === "boolean" ? "checkbox" : "text",
      value: String(value),
      checked: value,
    }),
  );
  const mode = {
    value: "visual",
    addEventListener(name, fn) {
      listeners.mode = fn;
    },
  };
  const fields = {
    hidden: false,
    innerHTML: "",
    querySelectorAll() {
      return controls;
    },
    addEventListener() {},
  };
  const json = { value: JSON.stringify(raw) },
    holder = { hidden: true },
    error = { hidden: true };
  const map = {
    "[data-control-mode]": mode,
    "[data-control-fields]": fields,
    "[data-step-json]": json,
    "[data-control-json]": holder,
    "[data-control-error]": error,
  };
  const collect = bindControlEditor({ querySelector: (key) => map[key] }, raw);
  controls.find((x) => x.dataset.controlKey === "root:count").value = "0";
  mode.value = "json";
  listeners.mode();
  assert.equal(mode.value, "visual");
  assert.equal(error.hidden, false);
  assert.throws(collect);
  controls.find((x) => x.dataset.controlKey === "root:count").value = "3";
  mode.value = "json";
  listeners.mode();
  assert.equal(JSON.parse(json.value).count, 3);
  assert.equal(fields.hidden, true);
  json.value = "{";
  mode.value = "visual";
  listeners.mode();
  assert.equal(mode.value, "json");
  assert.equal(json.value, "{");
  assert.equal(error.hidden, false);
  assert.throws(collect);
  assert.deepEqual(raw, original);
  const changed = { ...raw, count: 5, agentFuture: { x: 1 } };
  changed.steps[0].condition.extra = "future";
  json.value = JSON.stringify(changed);
  mode.value = "visual";
  listeners.mode();
  assert.equal(mode.value, "visual");
  assert.equal(error.hidden, true);
  assert.match(fields.innerHTML, /当前表单不支持/);
  assert.equal(fields.hidden, false);
  assert.equal(holder.hidden, true);
});

test("browser-normalized initial text is not treated as a user edit", async () => {
  const { bindControlEditor } = await import(
    "../public/plan-control-editor.js"
  );
  const raw = group();
  raw.name = "\r\nleading\rname";
  raw.steps[0].condition = {
    op: "eq",
    left: { literal: "\r\nbody\rnext\n" },
    right: { literal: "\r\nbody\rnext\n" },
  };
  snapshotPlan({ steps: [raw] });
  const controls = Object.entries(visualControlValues(raw)).map(
    ([controlKey, value]) => ({
      dataset: { controlKey },
      type: typeof value === "boolean" ? "checkbox" : "textarea",
      value: String(value).replace(/\r\n?/g, "\n"),
      checked: value,
    }),
  );
  const nodes = {
    "[data-control-mode]": { addEventListener() {} },
    "[data-control-fields]": {
      querySelectorAll: () => controls,
      addEventListener() {},
    },
    "[data-step-json]": {},
    "[data-control-json]": {},
    "[data-control-error]": {},
  };
  const collect = bindControlEditor({ querySelector: (k) => nodes[k] }, raw);
  assert.deepEqual(collect(), raw);
  controls.find((x) => x.dataset.controlKey === "root:count").value = "3";
  const edited = collect();
  assert.equal(edited.count, 3);
  assert.equal(edited.name, raw.name);
  assert.deepEqual(edited.steps, raw.steps);
});
