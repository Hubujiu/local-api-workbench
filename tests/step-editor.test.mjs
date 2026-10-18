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
test("advanced step edits preserve source metadata while editing auth assertions and extraction", () => {
  const step = {
    name: "step",
    request: {
      auth: { type: "basic", username: "source" },
      assertions: [{ target: "$.x", op: "eq", value: null, note: "retained" }],
      extract: [
        {
          name: "x",
          source: "xml",
          path: "/n:root",
          namespaces: { n: "urn:test" },
        },
      ],
    },
  };
  const next = applyStepEdits(
    step,
    { name: "step", auth: { type: "bearer", token: "step-token" } },
    {},
    {
      assertions: [{ index: 0, target: "status", op: "eq", value: "200" }],
      extract: [
        {
          index: 0,
          name: "value",
          source: "xml",
          scope: "runtime",
          path: "/n:root/text()",
          group: "0",
        },
      ],
    },
  );
  assert.equal(step.request.auth.type, "basic");
  assert.equal(next.request.auth.type, "bearer");
  assert.equal(next.request.assertions[0].value, 200);
  assert.equal(next.request.assertions[0].note, "retained");
  assert.deepEqual(next.request.extract[0].namespaces, { n: "urn:test" });
  assert(stepEditor(step).includes('value="null"'));
  assert(
    !stepEditor({
      name: "oauth",
      request: { auth: { type: "oauth2" } },
    }).includes('id="oauth-get"'),
  );
  assert.throws(
    () =>
      applyStepEdits(
        step,
        { name: "step" },
        {},
        {
          extract: [
            {
              index: -1,
              name: "__proto__",
              source: "json",
              scope: "runtime",
              group: 0,
            },
          ],
        },
      ),
    /名称/,
  );
});
