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

test("operation name is explicit; addition and omission preserve variable lexemes", () => {
  const drafts = createGraphQLWorkspaceDrafts();
  const original =
    '{"query":"query NotGuessed { value }","variables": { "n":9007199254740993, "m":1e-2 }}';
  const r = { ...newGraphQLEditorRequest(), body: original };
  drafts.edit(r, "operationName", undefined);
  assert.equal(drafts.pending(r), false);
  assert.equal(r.body, original);
  for (const value of ["", "bad-name", "valid\n"]) {
    drafts.edit(r, "operationName", value);
    assert.throws(() => drafts.apply(r), /操作名称须/);
    assert.equal(r.body, original);
    assert.equal(drafts.pending(r), true);
  }
  drafts.edit(r, "operationName", "Manually_Chosen");
  assert.equal(drafts.apply(r), true);
  assert.equal(JSON.parse(r.body).operationName, "Manually_Chosen");
  assert.match(r.body, /"n":9007199254740993, "m":1e-2/);
  drafts.edit(r, "operationName", undefined);
  assert.equal(drafts.apply(r), true);
  assert.equal(Object.hasOwn(JSON.parse(r.body), "operationName"), false);
  assert.match(r.body, /"n":9007199254740993, "m":1e-2/);
});

test("explicit historical empty survives unrelated edits but can be deliberately removed", () => {
  const drafts = createGraphQLWorkspaceDrafts();
  const r = {
    ...newGraphQLEditorRequest(),
    body: '{"query":"x","operationName":"","variables":null}',
  };
  drafts.edit(r, "query", "y");
  assert.equal(drafts.apply(r), true);
  assert.equal(r.body, '{"query":"y","operationName":"","variables":null}');
  drafts.edit(r, "operationName", "");
  assert.equal(drafts.pending(r), false);
  drafts.edit(r, "operationName", undefined);
  assert.equal(drafts.apply(r), true);
  assert.equal(r.body, '{"query":"y","variables":null}');
  const legacy = { ...r, body: '{"query":"x","operationName":null}' };
  assert.equal(drafts.read(legacy), null);
  assert.throws(() => drafts.edit(legacy, "operationName", "not applied"));
  assert.equal(legacy.body, '{"query":"x","operationName":null}');
});
