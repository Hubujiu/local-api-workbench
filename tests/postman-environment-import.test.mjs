import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject, importDocument } from "../src/core.mjs";
import { importPostmanEnvironment } from "../src/postman-environment-import.mjs";
const doc = () => ({
  name: "Staging",
  _postman_variable_scope: "environment",
  values: [
    { key: "host", value: "fixture-host", enabled: true, type: "default" },
  ],
});
const project = () => ({
  requests: [],
  environments: [{ id: "old", name: "Staging", variables: { host: "old" } }],
  currentEnvironmentId: "old",
});
test("standalone environment creates fresh identities without switch, overwrite or API conversion", () => {
  const p = project(),
    before = structuredClone(p);
  for (const input of [doc(), JSON.stringify(doc())])
    assert.deepEqual(importIntoProject(p, input), []);
  assert.equal(p.currentEnvironmentId, "old");
  assert.deepEqual(p.environments[0], before.environments[0]);
  assert.equal(p.environments.length, 3);
  assert.notEqual(p.environments[1].id, p.environments[2].id);
  assert.deepEqual(p.requests, []);
  assert.throws(() => importDocument(doc()), /无法识别/);
});
test("unsupported rows and envelope fields reject the entire environment without mutation", () => {
  const variants = [
    (d) => d.values.push({ ...d.values[0] }),
    (d) => (d.values[0].enabled = false),
    (d) => delete d.values[0].enabled,
    (d) => (d.values[0].type = "secret"),
    (d) => (d.values[0].value = "{{vault:fixture-key}}"),
    (d) => (d.values[0].type = "number"),
    (d) => (d.values[0].value = 1),
    (d) => (d.values[0].value = null),
    (d) => (d.values[0].source = "vault"),
    (d) => (d.values[0].key = "constructor"),
    (d) => (d.values[0].description = "unsupported"),
    (d) => (d.values[0].value = "\ud800"),
    (d) => (d.name = ""),
    (d) => (d.name = "x".repeat(201)),
    (d) => (d.values[0].value = "x".repeat(65537)),
    (d) => (d._postman_variable_scope = "globals"),
    (d) => (d.requests = []),
    (d) => (d.item = []),
    (d) => (d.secret = true),
    (d) => (d.values = new Array(1)),
    (d) => (d.values[0].enabled = "true"),
  ];
  for (const mutate of variants) {
    const d = doc();
    mutate(d);
    const p = project(),
      before = structuredClone(p);
    assert.throws(() => importIntoProject(p, d));
    assert.deepEqual(p, before);
  }
  for (const options of [
    { sync: true },
    { postmanVariableMode: "environment" },
    { postmanVariableMode: "collection" },
    { modelNameMode: "namespaced" },
    { inheritanceMode: "flatten" },
  ]) {
    const p = project(),
      before = structuredClone(p);
    assert.throws(() => importIntoProject(p, doc(), options));
    assert.deepEqual(p, before);
  }
});
test("plain text rows retain exact empty, Unicode and escaped string values with bounded inert metadata", () => {
  const d = doc();
  d.id = "foreign-id";
  d._postman_exported_at = "2025-01-01T00:00:00Z";
  d._postman_exported_using = "Postman";
  d.values = [
    { key: "empty", value: "", enabled: true },
    { key: "encoded", value: 'a\\b\n中"%2F', enabled: true, type: "text" },
  ];
  const e = importPostmanEnvironment(d, () => "new-id");
  assert.deepEqual(e, {
    id: "new-id",
    name: "Staging",
    variables: { empty: "", encoded: 'a\\b\n中"%2F' },
    serverUrls: {},
  });
  assert.notEqual(e.id, d.id);
});
test("descriptor-safe validation never invokes getters or proxy traps", () => {
  let calls = 0;
  const d = doc();
  Object.defineProperty(d.values[0], "value", {
    get() {
      calls++;
      return "secret";
    },
    enumerable: true,
  });
  assert.throws(() => importPostmanEnvironment(d, () => "id"));
  assert.equal(calls, 0);
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        return [];
      },
      get() {
        calls++;
        return "secret";
      },
    },
  );
  assert.throws(() => importPostmanEnvironment(proxy, () => "id"));
  assert.equal(calls, 0);
});

test("environment JSON rejects duplicate and escaped members without changing unrelated JSON parsing", async () => {
  const { parseImportDocumentText } = await import(
    "../src/import-document-parser.mjs"
  );
  for (const members of [
    '"type":"secret","type":"default"',
    '"enabled":false,"enabled":true',
    '"enabled":false,"enabl\\u0065d":true',
    '"value":"hidden","value":"visible"',
  ]) {
    const raw =
      '{"_postman_variable_scope":"environment","name":"fixture","values":[{"key":"a","value":"b","enabled":true,' +
      members +
      "}]}";
    const p = project(),
      before = structuredClone(p);
    assert.throws(() => importIntoProject(p, raw), /重复成员/);
    assert.deepEqual(p, before);
  }
  assert.throws(
    () =>
      parseImportDocumentText(
        '{"_postman_variable_scope":"environment","name":"x","hidden":{"x":1,"x":2},"hidden":null}',
      ),
    /重复成员/,
  );
  assert.deepEqual(
    parseImportDocumentText('{"requests":[],"note":"old","note":"new"}'),
    { requests: [], note: "new" },
  );
  const valid = doc();
  valid.values[0].value = 'a{[\\"quoted\\"]}';
  assert.deepEqual(parseImportDocumentText(JSON.stringify(valid)), valid);
});

test("external environment normalization requires raw JSON but retains other object formats", async () => {
  const { normalizeManualImportInput } = await import(
    "../src/manual-import-input.mjs"
  );
  const { parseImportDocumentText } = await import(
    "../src/import-document-parser.mjs"
  );
  const input = { format: "auto", document: doc(), selection: { mode: "all" } };
  assert.throws(() => normalizeManualImportInput(input), /原始JSON文本/);
  assert.doesNotThrow(() =>
    normalizeManualImportInput({ ...input, document: JSON.stringify(doc()) }),
  );
  assert.doesNotThrow(() =>
    normalizeManualImportInput({
      ...input,
      document: { info: { name: "normal collection" }, item: [] },
    }),
  );
  assert.throws(
    () =>
      parseImportDocumentText(
        "_postman_variable_scope: environment\nname: Env\nvalues: []\n",
      ),
    /原始JSON文本/,
  );
  assert.deepEqual(parseImportDocumentText("requests: []\n"), { requests: [] });
});
