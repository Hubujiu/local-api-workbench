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

test("inline field queue preserves typed names, commit adds real schema fields and cancel is non-mutating", () => {
  const draft = new WorkspaceModelDrafts().open("owner");
  const first = draft.tree.begin(draft.schema);
  const second = draft.tree.begin(draft.schema, first);
  assert.equal(draft.changed, false);
  assert.throws(() => draft.tree.assertResolved(), /确认或取消/);
  draft.tree.input(first, "identifier");
  draft.tree.input(second, "identifier");
  assert.equal(draft.changed, true);
  assert(draft.tree.confirm(draft, first));
  assert(!draft.tree.confirm(draft, second));
  assert.match(draft.tree.pending[0].error, /字段已存在/);
  draft.tree.cancel(second);
  assert.deepEqual(draft.schema.properties, { identifier: { type: "string" } });
  draft.tree.assertResolved();
});

test("visual children show real schema metadata, and unsupported schema remains available in Raw", () => {
  const draft = new WorkspaceModelDrafts().open("owner");
  draft.replaceSchema({
    type: "object",
    required: ["identifier"],
    properties: {
      identifier: { type: "integer", description: "<synthetic>" },
      unsafeType: { type: { toString: "invalid hint" } },
    },
  });
  const html = modelDraftPanel({}, draft);
  assert.match(html, /identifier<\/span>/);
  assert.match(html, /integer<\/span>/);
  assert.match(html, /必填<\/span>/);
  assert.match(html, /&lt;synthetic&gt;/);
  assert.doesNotMatch(html, /<synthetic>/);
  draft.tree.expanded = false;
  assert.match(modelDraftPanel({}, draft), /aria-expanded="false"/);
  draft.replaceSchema({ type: "object", properties: [] });
  assert.match(modelDraftPanel({}, draft), /请使用 Raw 编辑/);
  assert.doesNotMatch(modelDraftPanel({}, draft), /id="model-root-add"/);
});
