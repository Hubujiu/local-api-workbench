import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { exportApipost } from "../src/apipost-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";
import { verifyProtocolDefinitions } from "../src/apipost-protocol-export.mjs";
import { nativeProtocolFixture } from "./fixtures/apipost-native-protocols.mjs";
const exporters = [exportApipost, exportApipostDirectory];
const blank = () => ({
  id: "target",
  name: "target",
  requests: [],
  environments: [],
  folders: [],
  settings: {},
});
function fixture() {
  const source = nativeProtocolFixture();
  source.apis = [source.apis[0]];
  const ws = source.apis[0];
  ws.request.header.parameter = [
    { key: "Accept-Language", value: "zh-CN", is_checked: 1 },
  ];
  ws.message.push({
    param_id: "second",
    name: "Unicode",
    request: { mode: "text", raw: "雪😀 / second" },
    response: { mode: "text", raw: "inert second response" },
  });
  return source;
}
function imported(source) {
  const p = blank();
  importIntoProject(p, source);
  return p;
}
test("plaintext WebSocket complete ordered message groups roundtrip in both native formats twice", () => {
  for (const exporter of exporters) {
    const source = fixture(),
      initial = imported(source),
      before = structuredClone(initial);
    let current = initial;
    for (let generation = 0; generation < 2; generation++) {
      current = imported(exporter(current));
      verifyProtocolDefinitions(initial.protocols, current.protocols);
      assert.deepEqual(
        current.settings.apipostProtocolSources[0].source.message,
        source.apis[0].message,
      );
    }
    assert.deepEqual(initial, before);
  }
});

test("WS export rejects incomplete edited credentialed unsupported and historically collapsed groups atomically", () => {
  const original = imported(fixture());
  const mutations = [
    (p) => p.protocols.pop(),
    (p) => p.protocols.push({ ...p.protocols[0], id: "extra" }),
    (p) => (p.protocols[0].message = "edited"),
    (p) => (p.protocols[0].name = "edited"),
    (p) => p.settings.apipostProtocolSources.pop(),
    (p) =>
      (p.settings.apipostProtocolSources[0].source.config.reconnect_num = 0),
    (p) =>
      (p.settings.apipostProtocolSources[0].source.url = "wss://127.0.0.1:1/"),
    (p) =>
      (p.settings.apipostProtocolSources[0].source.url = "http://127.0.0.1:1/"),
    (p) => (p.settings.apipostProtocolSources[0].source.url += "#fragment"),
    (p) =>
      (p.settings.apipostProtocolSources[0].source.message[0].request.raw =
        "{{message}}"),
    (p) =>
      (p.settings.apipostProtocolSources[0].source.message[0].request.raw = ""),
    (p) =>
      delete p.settings.apipostProtocolSources[0].source.request.header
        .parameter[0].value,
  ];
  for (const mutate of mutations)
    for (const exporter of exporters) {
      const p = structuredClone(original);
      mutate(p);
      const before = structuredClone(p);
      assert.throws(() => exporter(p), /原生协议/);
      assert.deepEqual(p, before);
    }
  // Construct a historical collapsed archive from two independently legal imports,
  // never rely on an old importer silently accepting ambiguous identities.
  const a = fixture(),
    b = fixture();
  a.apis[0].message.length = 1;
  b.apis[0].message.length = 1;
  a.apis[0].target_id = "a:b";
  a.apis[0].message[0].param_id = "c";
  b.apis[0].target_id = "a";
  b.apis[0].message[0].param_id = "b:c";
  const left = imported(a),
    right = imported(b);
  left.settings.apipostProtocolSources.push(
    ...right.settings.apipostProtocolSources,
  );
  for (const exporter of exporters)
    assert.throws(() => exporter(left), /原生协议/);
});
