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
