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
        key: "Authorization",
        value: "secret",
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
    (d) => (d.apis[3].request.auth.type = "basic"),
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
    (d) => (d.apis[3].request.body.raw = "{{variable}}"),
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
