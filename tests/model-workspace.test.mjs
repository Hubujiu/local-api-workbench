import test from "node:test";
import assert from "node:assert/strict";
import {
  WorkspaceModelDrafts,
  modelDraftPanel,
  modelDraftTab,
} from "../public/model-workspace.js";

test("one unapplied local draft per project cannot replace or finish another", () => {
  const drafts = new WorkspaceModelDrafts();
  const owned = drafts.open("owner");
  const other = drafts.open("other");
  assert.deepEqual(owned.schema, { type: "object", properties: {} });
  assert.notEqual(owned.schema, other.schema);
  owned.name = "Model";
  assert(owned.changed);
  owned.active = false;
  assert.equal(drafts.open("owner"), owned);
  assert(owned.active);
  assert.equal(drafts.finish("other", owned), false);
  assert.equal(drafts.get("other"), other);
  assert(drafts.finish("owner", owned));
  assert.equal(drafts.get("owner"), undefined);
});

test("Raw rejects invalid roots and safely preserves supported schemas and text", () => {
  const draft = new WorkspaceModelDrafts().open("owner");
  assert.throws(() => draft.replaceSchema([]), /须为对象或布尔值/);
  assert.throws(
    () => draft.replaceSchema({ description: "中".repeat(400000) }),
    /最多1MiB/,
  );
  assert.equal(draft.changed, false);
  draft.replaceSchema(false);
  assert.match(modelDraftPanel({}, draft), />false<\/span>/);
  draft.replaceSchema({
    type: { toString: "invalid type hint" },
    description: '<img src="/external" onerror="ignored">',
  });
  draft.name = '<unsafe "name">';
  const html = modelDraftPanel({}, draft);
  assert.match(html, /未指定/);
  assert.match(html, /&lt;unsafe &quot;name&quot;&gt;/);
  assert.doesNotMatch(html, /<img /);
  assert.match(modelDraftTab(draft), /aria-current="page"/);
});
