import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { nativeProtocolFixture } from "./fixtures/apipost-native-protocols.mjs";
const project = () => ({
  requests: [],
  folders: [],
  environments: [],
  servers: [],
  globalVariables: {},
  settings: {},
});
test("native protocol import retains scoped definitions, exact mirrored query, TCP default and inert source metadata", () => {
  const source = nativeProtocolFixture(),
    original = JSON.stringify(source),
    p = project();
  importIntoProject(p, source);
  assert.equal(p.protocols.length, 3);
  assert(
    p.protocols.every(
      (definition) => !Object.hasOwn(definition, "templateMode"),
    ),
  );
  assert.equal(p.requests.length, 0);
  assert(p.folders.includes("TCP"));
  const tcp = p.protocols.find((p) => p.type === "tcp");
  assert.equal(tcp.duration, 10000);
  assert.equal(tcp.completion, "first-data");
  assert.equal(tcp.message, "wire-payload");
  assert.equal(
    p.protocols.find((p) => p.type === "sse").body,
    "fixture=synthetic",
  );
  assert.equal(
    p.protocols.find((p) => p.type === "websocket").url,
    "ws://127.0.0.1:1/echo?x=one",
  );
  assert.equal(p.settings.apipostProtocolSources.length, 4);
  assert(!JSON.stringify(p).includes("inactive-secret"));
  assert(!JSON.stringify(p).includes("not-retained"));
  assert.equal(JSON.stringify(source), original);
  const before = JSON.stringify(p);
  importIntoProject(p, source);
  assert.equal(JSON.stringify(p), before);
  const other = nativeProtocolFixture();
  other.project_id = "other";
  other.apis.forEach((n) => (n.project_id = "other"));
  const q = project();
  importIntoProject(q, other);
  assert.notEqual(q.protocols[0].id, p.protocols[0].id);
});
test("native protocol unsupported semantics and identity conflicts fail atomically", () => {
  const cases = [
    (d) => (d.apis[3].config = { arbitrary: true }),
    (d) => (d.apis[0].method = "POST"),
    (d) => (d.apis[3].request.header.arbitrary = true),
    (d) =>
      d.apis[0].request.header.parameter.push({
        key: "Host",
        value: "override.invalid",
        is_checked: 1,
      }),
    (d) => (d.apis[0].message[0].request.mode = "binary"),
    (d) => (d.apis[0].config.reconnect_num = 99),
    (d) => (d.apis[1].request.end_func.name = "endedChar"),
    (d) => (d.apis[1].request.timeout = 0),
    (d) => d.apis[2].request.configs.func.request.push("arbitrary"),
    (d) =>
      d.apis[2].request.post_tasks.push({
        type: "javascript",
        data: "throw 1",
      }),
    (d) => (d.apis[3].request.auth.type = "oauth2"),
    (d) => (d.apis[3].method = "DELETE"),
    (d) => (d.apis[3].request.query.parameter[0].is_checked = -1),
    (d) =>
      (d.global.global_param.query = {
        parameter: [{ key: "x", value: "inherited" }],
      }),
    (d) => (d.apis[0].url = "wss://user:secret@example.invalid"),
    (d) => (d.apis[0].project_id = "foreign"),
    (d) => (d.apis[2].parent_id = "missing"),
    (d) => d.apis[0].message.push(structuredClone(d.apis[0].message[0])),
    (d) => (d.apis[3].request.body.raw = "{{foo()}}"),
  ];
  for (const mutate of cases) {
    const source = nativeProtocolFixture();
    mutate(source);
    const p = project(),
      before = JSON.stringify(p);
    assert.throws(() => importIntoProject(p, source));
    assert.equal(JSON.stringify(p), before);
  }
});
test("native text payload templates map only bounded whole-key names and retain their source", () => {
  const source = nativeProtocolFixture();
  const payload =
    "{{ 租户 }}|{{a.b}}|{{with-hyphen}}|{{zero}}|{{no}}|{{empty}}";
  source.apis[0].message[0].request.raw = payload;
  source.apis[2].request.body.raw = payload;
  source.apis[3].request.body.raw = payload;
  const before = JSON.stringify(source),
    p = project();
  importIntoProject(p, source);
  assert(
    p.protocols.every((definition) => definition.templateMode === "variables"),
  );
  assert(
    p.protocols.every(
      (definition) => (definition.message ?? definition.body) === payload,
    ),
  );
  assert.equal(JSON.stringify(source), before);
  assert.equal(
    p.settings.apipostProtocolSources[0].source.message[0].request.raw,
    payload,
  );
  for (const invalid of [
    "{{foo()}}",
    "{{a+b}}",
    "{{$guid}}",
    "{{two words}}",
    "{{a/b}}",
    "{{'quoted'}}",
    "{{}}",
    "{{missing",
    "{{a{b}}",
    "{{__proto__}}",
    "{{constructor}}",
    "{{prototype}}",
    "{{" + "a".repeat(201) + "}}",
  ])
    for (const index of [0, 2, 3]) {
      const bad = structuredClone(source),
        candidate = project(),
        original = JSON.stringify(candidate);
      if (index === 0) bad.apis[0].message[0].request.raw = invalid;
      else bad.apis[index].request.body.raw = invalid;
      assert.throws(
        () => importIntoProject(candidate, bad),
        undefined,
        invalid,
      );
      assert.equal(JSON.stringify(candidate), original);
    }
});

test("native protocol ordering permits only the known zero inner default", async () => {
  const { assembleApipostDirectory } = await import(
    "../src/apipost-directory.mjs"
  );
  const source = nativeProtocolFixture(),
    records = source.apis.map((n, i) => ({ ...n, sort: i + 1, data: n }));
  const doc = {
    format: "apipost-offline-directory-v1",
    files: [
      {
        path: "project.json",
        text: JSON.stringify({
          project_id: source.project_id,
          name: source.name,
        }),
      },
      {
        path: "apis/index.json",
        text: JSON.stringify({
          project_id: source.project_id,
          items: records.map(({ data, ...n }) => n),
        }),
      },
      ...records.map((n) => ({
        path: "apis/" + n.target_id + ".json",
        text: JSON.stringify(n),
      })),
    ],
  };
  assert.equal(assembleApipostDirectory(doc).apis[2].sort, 3);
  for (const mutate of [
    (n) => (n.data.sort = 99),
    (n) => (n.data.name = "conflict"),
    (n) => (n.data.project_id = "foreign"),
    (n) => (n.data.target_id = "foreign"),
  ]) {
    const bad = structuredClone(doc),
      row = JSON.parse(bad.files[2].text);
    mutate(row);
    bad.files[2].text = JSON.stringify(row);
    assert.throws(() => assembleApipostDirectory(bad));
  }
  const p = project();
  importIntoProject(p, doc);
  assert.equal(p.protocols.length, 3);
});
test("native query mirrors consume multiplicity without re-encoding original spelling", () => {
  const source = nativeProtocolFixture();
  source.apis[0].url = "ws://127.0.0.1:1/?x=a+b&x=a%20b&literal=%2b";
  source.apis[0].request.query.parameter = [
    { key: "x", value: "a b", is_checked: 1 },
    { key: "x", value: "a b", is_checked: 1 },
    { key: "x", value: "a b", is_checked: 1 },
    { key: "literal", value: "+", is_checked: 1 },
  ];
  const p = project();
  importIntoProject(p, source);
  assert.equal(
    p.protocols[0].url,
    "ws://127.0.0.1:1/?x=a+b&x=a%20b&literal=%2b&x=a+b",
  );
});

test("WebSocket legacy composed identities reject same-batch and archived cross-batch collisions", () => {
  const source = nativeProtocolFixture();
  const a = source.apis[0],
    b = structuredClone(a);
  a.target_id = "a:b";
  a.message[0].param_id = "c";
  b.target_id = "a";
  b.message[0].param_id = "b:c";
  source.apis = [a, b];
  const p = project(),
    empty = structuredClone(p);
  assert.throws(() => importIntoProject(p, source), /身份拼接歧义/);
  assert.deepEqual(p, empty);
  importIntoProject(p, { ...source, apis: [a] });
  const saved = structuredClone(p);
  importIntoProject(p, { ...source, apis: [a] });
  assert.deepEqual(p, saved);
  assert.throws(
    () => importIntoProject(p, { ...source, apis: [b] }),
    /身份拼接歧义/,
  );
  assert.deepEqual(p, saved);
  const sse = nativeProtocolFixture().apis[3];
  sse.target_id = "a:b:c";
  assert.throws(
    () => importIntoProject(p, { ...source, apis: [sse] }),
    /身份拼接歧义/,
  );
  assert.deepEqual(p, saved);
  const other = {
    ...source,
    project_id: "other-ws",
    apis: [{ ...b, project_id: "other-ws" }],
  };
  importIntoProject(p, other);
  assert.equal(p.protocols.length, 2);
});

test("native empty WebSocket text carries explicit send intent without template mode", () => {
  const source = nativeProtocolFixture(),
    p = project();
  source.apis = [source.apis[0]];
  source.apis[0].message[0].request.raw = "";
  importIntoProject(p, source);
  assert.equal(p.protocols[0].sendEmptyMessage, true);
  assert.equal(p.protocols[0].templateMode, undefined);
});
