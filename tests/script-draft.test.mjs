import test from "node:test";
import assert from "node:assert/strict";
import { createScriptDraft, applyScriptDraft } from "../public/script-draft.js";

test("script draft does not mutate until applied and preserves the other stage", () => {
  const project = {},
    request = { beforeScript: "old", afterScript: "after" };
  const draft = createScriptDraft(project, request, "before");
  assert.equal(draft.text, "old");
  assert.equal(request.beforeScript, "old");
  assert.equal(
    applyScriptDraft(draft, project, request, "before", "old"),
    false,
  );
  assert.equal(
    applyScriptDraft(
      draft,
      project,
      request,
      "before",
      "throw Error('not executed')",
    ),
    true,
  );
  assert.equal(request.beforeScript, "throw Error('not executed')");
  assert.equal(request.afterScript, "after");
});
test("script draft rejects stale projects, requests, stages and changed source", () => {
  for (const variant of ["project", "request", "stage", "changed"]) {
    const project = {},
      request = { beforeScript: "old" };
    const draft = createScriptDraft(project, request, "before");
    if (variant === "changed") request.beforeScript = "newer";
    assert.throws(
      () =>
        applyScriptDraft(
          draft,
          variant === "project" ? {} : project,
          variant === "request" ? { ...request } : request,
          variant === "stage" ? "after" : "before",
          "draft",
        ),
      /已变更/,
    );
    assert.equal(request.beforeScript, variant === "changed" ? "newer" : "old");
  }
});
test("script draft accepts an empty script but rejects invalid stages and non-text values", () => {
  const project = {},
    request = {};
  assert.throws(() => createScriptDraft(project, request, "body"), /阶段/);
  const draft = createScriptDraft(project, request, "after");
  assert.equal(draft.text, "");
  assert.throws(
    () => applyScriptDraft(draft, project, request, "after", {}),
    /文本/,
  );
  assert.equal(applyScriptDraft(draft, project, request, "after", ""), false);
  assert.deepEqual(request, {});
});
