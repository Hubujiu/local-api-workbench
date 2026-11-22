import test from "node:test";
import assert from "node:assert/strict";
import { createGraphQLWorkspaceDrafts } from "../public/graphql-workspace.js";
import { newGraphQLEditorRequest } from "../public/graphql-editor.js";

test("staged changes stay with the original object even for matching IDs", () => {
  const drafts = createGraphQLWorkspaceDrafts();
  const a = { id: "same", ...newGraphQLEditorRequest() };
  const b = structuredClone(a);
  assert.equal(drafts.pending(a), false);
  drafts.edit(a, "query", "query Fixture { item }");
  assert.equal(drafts.pending(a), true);
  assert.equal(drafts.pending(b), false);
  assert.equal(drafts.hasProject({ requests: [a] }), true);
  assert.equal(drafts.hasProject({ requests: [b] }), false);
  assert.equal(a.body, b.body);
  drafts.showVariables(a, true);
  assert.equal(drafts.variablesOpen(a), true);
  assert.equal(drafts.variablesOpen(b), false);
  assert.equal(drafts.apply(b), false);
  assert.equal(drafts.apply(a), true);
  assert.equal(JSON.parse(a.body).query, "query Fixture { item }");
  assert.equal(JSON.parse(b.body).query, "");
  assert.equal(drafts.pending(a), false);
});

test("invalid drafts, stale ownership and discard never replace existing bytes", () => {
  const drafts = createGraphQLWorkspaceDrafts();
  const row = {
    ...newGraphQLEditorRequest(),
    body: '{"query":"query Test { item }","variables":{\r\n "count":1e2\r\n}}',
  };
  const before = row.body;
  drafts.edit(row, "variablesSource", '{\n "count":1e2\n}');
  assert.equal(
    drafts.pending(row),
    false,
    "textarea newline normalization is not an edit",
  );
  drafts.edit(row, "query", "new query");
  drafts.edit(row, "variablesSource", "{not valid");
  assert.throws(() => drafts.apply(row));
  assert.equal(row.body, before);
  assert.equal(drafts.pending(row), true);
  row.body = '{"query":"newer"}';
  assert.throws(() => drafts.apply(row), /正文已变化/);
  assert.equal(row.body, '{"query":"newer"}');
  assert.equal(drafts.discard(row), true);
  assert.equal(drafts.pending(row), false);
});
