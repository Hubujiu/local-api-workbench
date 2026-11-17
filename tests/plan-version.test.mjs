import test from "node:test";
import assert from "node:assert/strict";
import { versionPlan } from "../src/plan-version.mjs";
test("plan provenance tracks changed fields and steps without recoloring unchanged AI values", () => {
  const ai = versionPlan(
    null,
    {
      name: "AI flow",
      description: "AI explanation",
      steps: [{ request: { url: "http://localhost" } }],
    },
    "ai",
  );
  assert.equal(ai.provenance.fields.name, "ai");
  assert.equal(ai.provenance.steps[ai.steps[0].id], "ai");
  const manual = versionPlan(
    ai,
    { ...ai, description: "Human correction" },
    "manual",
  );
  assert.equal(manual.provenance.fields.name, "ai");
  assert.equal(manual.provenance.fields.description, "manual");
  assert.equal(manual.provenance.steps[ai.steps[0].id], "ai");
  const edited = structuredClone(manual);
  edited.steps[0].request.url = "http://localhost/new";
  const changed = versionPlan(manual, edited, "manual");
  assert.equal(changed.provenance.steps[ai.steps[0].id], "manual");
});

test("status policy edits are versioned and no-op policy saves preserve the prior timestamp", () => {
  const old = versionPlan(
    null,
    { name: "test", statusPolicy: "assertions", steps: [] },
    "ai",
  );
  old.updatedAt = "2026-01-01T00:00:00Z";
  const next = versionPlan(
    old,
    { ...old, statusPolicy: "strict200" },
    "manual",
  );
  assert.equal(next.statusPolicy, "strict200");
  assert.equal(next.provenance.fields.statusPolicy, "manual");
  assert.notEqual(next.updatedAt, old.updatedAt);
  assert.deepEqual(versionPlan(next, next, "manual"), next);
});

test("newly created plans default to original strict-200 while existing legacy policy remains unchanged", () => {
  const created = versionPlan(null, { name: "new", steps: [] }, "manual");
  assert.equal(created.statusPolicy, "strict200");
  assert.equal(
    versionPlan(created, { name: "updated", steps: [] }, "manual").statusPolicy,
    "strict200",
  );
  const legacy = { ...created, statusPolicy: "assertions" };
  const updated = versionPlan(legacy, { ...legacy, name: "renamed" }, "manual");
  assert.equal(updated.statusPolicy, "assertions");
  assert.equal(
    versionPlan(
      null,
      { name: "explicit", statusPolicy: "assertions", steps: [] },
      "manual",
    ).statusPolicy,
    "assertions",
  );
});
