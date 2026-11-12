import test from "node:test";
import assert from "node:assert/strict";
import { snapshotPlan } from "../src/core.mjs";
import { renderPlans } from "../public/plan-view.js";
import { stepEditor, bindStepEditor } from "../public/step-editor.js";
import { parsePlanStepJSON } from "../public/plan-step-types.js";
const group = () => ({
  id: "loop",
  type: "repeat",
  count: 2,
  steps: [
    {
      id: "condition",
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
const render = (steps) =>
  renderPlans({
    project: {
      plans: [{ id: "plan", name: "plan", steps }],
      runs: [],
      environments: [],
    },
    planId: "plan",
  });
test("server admitted repeat/if plans open with nested identities and no mutation", () => {
  const plan = snapshotPlan({ steps: [group()] });
  const before = structuredClone(plan);
  const html = render(plan.steps);
  assert.match(html, /data-plan-node="1.1.1"/);
  assert.match(html, /循环/);
  assert.match(html, /条件/);
  assert.match(html, /GET/);
  assert.equal((html.match(/data-step-edit=/g) || []).length, 1);
  assert.deepEqual(plan, before);
});
for (const step of [
  {
    id: "p",
    type: "protocol",
    protocol: { definition: { type: "sse", url: "http://localhost/events" } },
  },
  {
    id: "p",
    type: "grpc",
    grpc: { definition: { target: "grpc://localhost:50051" }, messages: [{}] },
  },
  {
    id: "p",
    type: "socketio",
    socketio: { definition: { url: "http://localhost/socket" }, commands: [] },
  },
  { id: "p", type: "future", future: { opaque: ["retain", 1] } },
])
  test(`${step.type} displays and JSON roundtrips without projecting protocol fields`, () => {
    const original = structuredClone(step);
    assert.match(render([step]), /编辑 JSON/);
    assert.match(stepEditor(step), /data-step-json/);
    const container = {
      querySelector(selector) {
        assert.equal(selector, "[data-step-json]");
        return { value: JSON.stringify(step) };
      },
    };
    assert.deepEqual(bindStepEditor(container, step)(), original);
    assert.deepEqual(step, original);
  });
test("advanced edits retain every child and condition while changing repeat count", () => {
  const before = group(),
    edit = structuredClone(before);
  edit.count = 3;
  const result = parsePlanStepJSON(before, JSON.stringify(edit));
  assert.equal(result.count, 3);
  assert.deepEqual(result.steps, before.steps);
  assert.equal(before.count, 2);
  assert.equal(snapshotPlan({ steps: [result] }).steps[0].count, 3);
});
test("invalid advanced edits reject without changing original", () => {
  const step = group(),
    before = structuredClone(step);
  for (const text of [
    "{",
    "null",
    "[]",
    "1",
    JSON.stringify({ ...step, id: "changed" }),
    JSON.stringify({ ...step, type: "http" }),
    " ".repeat(4194305),
  ])
    assert.throws(() => parsePlanStepJSON(step, text));
  assert.deepEqual(step, before);
});
test("untrusted advanced fields escape markup and disabled ancestors label descendants", () => {
  const step = group();
  step.enabled = false;
  step.name = "</textarea><img src=x onerror=alert(1)>";
  step.steps[0].steps[0].request.url = "<script>x</script>";
  const html = render([step]);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;script&gt;/);
  assert.equal((html.match(/已禁用（含上层禁用）/g) || []).length, 3);
  assert.ok(!stepEditor(step).includes("<img"));
});

test("canonical frozen multi-protocol snapshots retain full payloads through display/edit/admission", async () => {
  const { readFile } = await import("node:fs/promises");
  const proto = await readFile(
    new URL("./fixtures/grpc.proto", import.meta.url),
    "utf8",
  );
  const specs = [
    {
      id: "rpc",
      type: "grpc",
      grpc: {
        definition: {
          proto,
          target: "grpc://127.0.0.1:50051",
          service: "fixture.Echo",
          method: "Unary",
        },
        messages: [{ text: "{{input}}" }],
      },
      extract: [{ name: "reply", path: "$[0].text" }],
    },
    {
      id: "socket",
      type: "socketio",
      socketio: {
        definition: { url: "http://127.0.0.1:3000" },
        timeoutMs: 2000,
        commands: [
          {
            type: "emit",
            event: "echo",
            args: [{ text: "{{input}}" }],
            ackTimeoutMs: 1000,
          },
        ],
      },
      extract: [{ name: "reply", path: "$[0].args[0].text" }],
    },
    {
      id: "sse",
      type: "protocol",
      protocol: {
        definition: { type: "sse", url: "http://127.0.0.1:3000/events" },
      },
    },
  ];
  for (const spec of specs) {
    const frozen = snapshotPlan({ steps: [spec] }).steps[0];
    const before = structuredClone(frozen);
    assert.doesNotThrow(() => render([frozen]));
    assert.match(stepEditor(frozen), /data-step-json/);
    const edited = parsePlanStepJSON(
      frozen,
      JSON.stringify({ ...frozen, name: "Renamed" }),
    );
    const admitted = snapshotPlan({ steps: [edited] }).steps[0];
    assert.deepEqual(admitted, { ...before, name: "Renamed" });
    assert.deepEqual(frozen, before);
  }
});
