import test from "node:test";
import assert from "node:assert/strict";
import { applyStepEdits, stepEditor } from "../public/step-editor.js";
test("visual step edits preserve snapshot identity, metadata and untouched advanced settings", () => {
  const step = {
    id: "step",
    name: "original",
    enabled: true,
    request: {
      url: "https://example.test",
      method: "GET",
      headers: [
        {
          key: "x",
          value: "old",
          schema: { type: "string" },
          description: "kept",
        },
      ],
      auth: { type: "bearer", token: "{{token}}" },
      form: [{ key: "file", type: "file", data: "abc" }],
      assertions: [{ target: "status", value: 200 }],
    },
  };
  const edited = applyStepEdits(
    step,
    {
      name: "changed",
      method: "POST",
      body: "{}",
      beforeScript: 'apt.setVar("x",1)',
    },
    {
      headers: [
        { index: 0, key: "x", value: "new", enabled: false },
        { index: -1, key: "new", value: "value", enabled: true },
      ],
    },
  );
  assert.equal(edited.id, step.id);
  assert.equal(edited.request.headers[0].description, "kept");
  assert.equal(edited.request.headers[0].enabled, false);
  assert.deepEqual(edited.request.auth, step.request.auth);
  assert.deepEqual(edited.request.form, step.request.form);
  assert.deepEqual(edited.request.assertions, step.request.assertions);
  assert.equal(step.request.headers[0].value, "old");
  assert.throws(() => applyStepEdits(step, { name: " " }, {}), /不能为空/);
  assert(
    !stepEditor({ ...step, name: "<img onerror=x>" }).includes(
      "<img onerror=x>",
    ),
  );
});
