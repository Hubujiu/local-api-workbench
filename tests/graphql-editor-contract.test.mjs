import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enableGraphQLEditor,
  graphQLEditorVersion,
  newGraphQLEditorRequest,
  prepareGraphQLEdit,
  readGraphQLEditor,
} from "../public/graphql-editor.js";
import {
  exportOpenAPI,
  importDocument,
  normalizeRequest,
  snapshotPlan,
  toCurl,
} from "../src/core.mjs";
import { Store } from "../src/runtime.mjs";

const withBody = (body) => ({ ...newGraphQLEditorRequest(), body });
const lexical =
  "\r\n  " +
  String.raw`{"large":90071992547409929,"minus":-0,"exp":1e+999,"escape":"\u0041\n","dup":0,"dup":1}` +
  "\t ";
const queryToken = String.raw`"\u0071uery Example { value }"`;
const full = ` \n{"variables":${lexical},"query" : ${queryToken}} \t`;

test("only explicit validated opt-in enables editing; plain HTTP and original Postman GraphQL retain their old shape", () => {
  const ordinary = { method: "POST", bodyType: "json", body: full };
  assert.equal(readGraphQLEditor(ordinary), null);
  assert.equal(graphQLEditorVersion(normalizeRequest(ordinary)), undefined);
  assert.deepEqual(enableGraphQLEditor(ordinary), { graphqlEditorVersion: 1 });
  assert.equal(Object.hasOwn(ordinary, "graphqlEditorVersion"), false);
  assert.equal(ordinary.body, full);
  assert.deepEqual(readGraphQLEditor(newGraphQLEditorRequest()), { query: "" });
  const [imported] = importDocument({
    info: {
      name: "Synthetic static GraphQL",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: "GraphQL import",
        request: {
          method: "POST",
          url: "https://example.invalid/graphql",
          body: {
            mode: "graphql",
            graphql: { query: "query { field }", variables: "{}" },
          },
        },
      },
    ],
  });
  assert.equal(imported.bodyType, "json");
  assert.equal(Object.hasOwn(imported, "graphqlEditorVersion"), false);
  assert.equal(readGraphQLEditor(imported), null);
});

test("structured edits preserve untouched wire lexemes, null versus absence, and query literals", () => {
  const original = withBody(full);
  assert.deepEqual(readGraphQLEditor(original), {
    query: "query Example { value }",
    variablesSource: lexical,
  });
  assert.equal(prepareGraphQLEdit(original, {}), full);
  assert.equal(
    prepareGraphQLEdit(original, { query: "query Example { value }" }),
    full,
  );
  const query = 'query Example { literal(text:"hello\\n") }\n';
  const changed = prepareGraphQLEdit(original, { query });
  assert.equal(changed, full.replace(queryToken, JSON.stringify(query)));
  assert.equal(readGraphQLEditor(withBody(changed)).variablesSource, lexical);
  assert.equal(readGraphQLEditor(withBody(changed)).query, query);
  assert.equal(
    prepareGraphQLEdit(original, { variablesSource: lexical }),
    full,
  );
  assert.equal(
    prepareGraphQLEdit(original, { variablesSource: "null" }),
    full.replace(lexical, "null"),
  );
  const withName = prepareGraphQLEdit(original, { operationName: "Example" });
  assert.deepEqual(readGraphQLEditor(withBody(withName)), {
    variablesSource: lexical,
    query: "query Example { value }",
    operationName: "Example",
  });
  assert(withName.includes(queryToken));
  const withoutName = prepareGraphQLEdit(withBody(withName), {
    operationName: undefined,
  });
  assert.equal(
    Object.hasOwn(readGraphQLEditor(withBody(withoutName)), "operationName"),
    false,
  );
  const withoutVariables = prepareGraphQLEdit(original, {
    variablesSource: undefined,
  });
  assert.deepEqual(readGraphQLEditor(withBody(withoutVariables)), {
    query: "query Example { value }",
  });
  assert.equal(original.body, full);
});

test("unsupported envelopes stay original and readable as Raw; adoption never loses members", () => {
  const unsupported = [
    '{"query":"x","extensions":{}}',
    '{"query":"x","\\u0071uery":"y"}',
    '{"variables":{}}',
    '{"query":null}',
    '{"query":"x","operationName":null}',
    '{"query":"x","variables":[]}',
    '{"query":"x","variables":0}',
    '{"query":"x","variables":{"bad":1,}}',
    '{"query":"x","variables":{"bad":00}}',
    '{"query":"x","variables":{"bad":"\\q"}}',
    '{"query":"x"}x',
    '{"query":"x","variables":{"bad":"\\u007b\\u007bname}}"}}',
    '{"query":"\\ud800"}',
    '{"query":"x","variables":{"deep":' +
      "[".repeat(66) +
      "0" +
      "]".repeat(66) +
      "}}",
    '{"query":"' + "中".repeat(360000) + '"}',
  ];
  for (const body of unsupported) {
    const r = withBody(body);
    assert.equal(readGraphQLEditor(r), null);
    assert.throws(() => enableGraphQLEditor(r), /GraphQL 编辑器仅支持/);
    assert.throws(
      () => prepareGraphQLEdit(r, { query: "" }),
      /GraphQL 编辑器仅支持/,
    );
    assert.equal(normalizeRequest(r).body, body);
    assert.equal(r.body, body);
  }
  for (const conflict of [
    { method: "GET" },
    { bodyType: "raw" },
    { bodyDynamic: { incompatible: true } },
    { postmanRawBody: { version: 1, language: "json" } },
    { graphqlVariableTemplate: { version: 1 } },
  ]) {
    const r = { ...withBody(full), ...conflict };
    assert.equal(readGraphQLEditor(r), null);
    assert.throws(() => enableGraphQLEditor(r), /GraphQL 编辑器仅支持/);
    assert.equal(r.body, full);
  }
  for (const variablesSource of ["", " ", "[]", "true", "null trailing"]) {
    assert.throws(
      () => prepareGraphQLEdit(withBody(full), { variablesSource }),
      /GraphQL 编辑器仅支持/,
    );
  }
  assert.throws(
    () => normalizeRequest({ ...withBody(full), graphqlEditorVersion: "1" }),
    /GraphQL 编辑器仅支持/,
  );
});

test("marker and canonical bytes survive save/reopen, backup/restore and freeze without changing existing exports", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "workbench-graphql-editor-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new Store(home);
  const project = await store.create("GraphQL editor fixture");
  const authored = normalizeRequest({
    ...withBody(full),
    id: "graphql-editor-fixture",
    name: "Synthetic GraphQL",
    url: "https://example.invalid/graphql",
  });
  const ordinary = { ...authored };
  delete ordinary.graphqlEditorVersion;
  const plan = snapshotPlan({ name: "Frozen", steps: [{ request: authored }] });
  assert.equal(plan.steps[0].request.graphqlEditorVersion, 1);
  assert.equal(plan.steps[0].request.body, full);
  project.requests = [authored];
  project.plans = [plan];
  await store.save(project);
  const reopened = await new Store(home).get(project.id);
  assert.equal(
    readGraphQLEditor(reopened.requests[0]).variablesSource,
    lexical,
  );
  assert.equal(reopened.requests[0].body, full);
  const restored = await store.restore(JSON.stringify(reopened));
  assert.notEqual(restored.id, reopened.id);
  assert.equal(restored.requests[0].graphqlEditorVersion, 1);
  assert.equal(restored.requests[0].body, full);
  assert.equal(restored.plans[0].steps[0].request.body, full);

  const finite = {
    ...authored,
    body: '{"query":"query Example { value }","variables":{"n":-0}}',
  };
  const plain = { ...finite };
  delete plain.graphqlEditorVersion;
  assert.equal(toCurl(finite), toCurl(plain));
  assert.deepEqual(
    exportOpenAPI({ name: "Fixture", requests: [finite] }),
    exportOpenAPI({ name: "Fixture", requests: [plain] }),
  );
  assert.equal(Object.hasOwn(ordinary, "graphqlEditorVersion"), false);
  assert.equal(Object.hasOwn(authored, "graphqlVariableTemplate"), false);
  const draft = await store.get(project.id);
  draft.requests[0].graphqlEditorVersion = "1";
  await assert.rejects(store.save(draft), /GraphQL 编辑器仅支持/);
  assert.equal(
    (await store.get(project.id)).requests[0].graphqlEditorVersion,
    1,
  );
});
