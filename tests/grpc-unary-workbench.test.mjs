import test from "node:test";
import assert from "node:assert/strict";
import {
  createGrpcUnaryState,
  createGrpcUnaryController,
  renderGrpcUnary,
  selectGrpcUnary,
  invalidateGrpcUnary,
} from "../public/grpc-unary-workbench.js";
const schema = {
  sha256: "a".repeat(64),
  services: [
    {
      name: "Echo",
      methods: [
        { name: "Unary", requestStream: false, responseStream: false },
        { name: "Stream", requestStream: false, responseStream: true },
      ],
    },
  ],
};
const definition = {
  id: "d",
  name: "Echo",
  target: "grpc://localhost:50051",
  proto: 'syntax="proto3";',
  service: "Echo",
  method: "Unary",
  timeoutMs: 5000,
};
function harness() {
  const state = createGrpcUnaryState(),
    calls = [],
    busy = [],
    saves = [],
    cancels = [];
  let active = true;
  const controller = createGrpcUnaryController({
    state,
    definitions: [definition],
    post: (action, body) =>
      new Promise((resolve, reject) =>
        calls.push({ action, body, resolve, reject }),
      ),
    saveDefinition: async (d) => {
      saves.push(d);
      return d;
    },
    assertCurrent() {
      if (!active) throw Error("old owner");
    },
    setBusy: (v) => busy.push(v),
    uid: () => "run-1",
    cancelRun: async (id) => cancels.push(id),
  });
  return {
    state,
    controller,
    calls,
    busy,
    saves,
    cancels,
    invalidate() {
      invalidateGrpcUnary(state);
      active = false;
    },
  };
}
function ready(h) {
  selectGrpcUnary(h.state, definition);
  h.state.services = structuredClone(schema.services);
  h.state.schemaReady = true;
}
const receipt = {
  runId: "run-1",
  messages: [{ text: "hello" }],
  status: { code: 0, details: "" },
  metadata: [],
  trailers: [],
  durationMs: 1,
  recordSaved: true,
};
test("render exposes unary, proto, explicit reflection and credential warnings without implicit network", () => {
  const h = harness();
  const html = renderGrpcUnary(h.state, [definition]);
  assert.match(html, /grpc-reflect-list/);
  assert.match(html, /JSON编辑器/);
  assert.match(html, /grpc-run\" disabled/);
  assert.equal(h.calls.length, 0);
});
test("schema inspect and explicit example use source only and apply matching receipt", async () => {
  const h = harness();
  h.controller.edit("proto", definition.proto);
  const p = h.controller.inspect();
  assert.deepEqual(h.calls[0].body, { proto: definition.proto });
  h.calls[0].resolve(schema);
  await p;
  h.controller.edit("method", "Unary");
  const example = h.controller.example();
  h.calls[1].resolve({
    service: "Echo",
    method: "Unary",
    example: { text: "hi" },
    skippedRecursiveFields: [],
  });
  await example;
  assert.match(h.state.message, /hi/);
  assert.equal(h.calls.length, 2);
});
test("changed source invalidates schema reply", async () => {
  const h = harness();
  const p = h.controller.inspect();
  h.controller.edit("proto", "new");
  h.calls[0].resolve(schema);
  await p;
  assert.equal(h.state.schemaReady, false);
  assert.deepEqual(h.busy, [true, false]);
});
test("closed owner cannot apply a late example", async () => {
  const h = harness();
  ready(h);
  const p = h.controller.example();
  h.invalidate();
  h.calls[0].resolve({
    service: "Echo",
    method: "Unary",
    example: { secret: "late" },
    skippedRecursiveFields: [],
  });
  await p;
  assert.equal(h.state.message, "{}");
});
test("save receives definition whitelist, never message or runtime credentials", async () => {
  const h = harness();
  ready(h);
  h.controller.edit("metadata", '[{"key":"authorization","value":"SECRET"}]');
  h.controller.edit("key", "PRIVATE");
  h.controller.edit("message", '{"payload":"BUSINESS"}');
  await h.controller.save();
  assert.equal(h.saves.length, 1);
  assert(!JSON.stringify(h.saves).includes("SECRET"));
  assert(!JSON.stringify(h.saves).includes("PRIVATE"));
  assert(!JSON.stringify(h.saves).includes("BUSINESS"));
  assert.equal(h.state.draftDirty, false);
});
test("unary sends only saved definition id and a snapshot, renders truthful recording receipt", async () => {
  const h = harness();
  ready(h);
  h.controller.edit("metadata", '[{"key":"x-test","value":"one"}]');
  const p = h.controller.run();
  assert.equal(h.calls[0].action, "grpc-run");
  assert.equal(h.calls[0].body.definitionId, "d");
  assert.equal(h.calls[0].body.proto, undefined);
  assert.equal(h.calls[0].body.metadata[0].value, "one");
  h.calls[0].resolve({ ...receipt, recordSaved: false });
  await p;
  assert.match(h.state.notice, /未保存/);
  assert.equal(h.state.result.recordSaved, false);
});
test("streaming and edited unsaved definition cannot call", async () => {
  const h = harness();
  ready(h);
  h.controller.edit("method", "Stream");
  await assert.rejects(h.controller.run(), /仅支持unary/);
  h.controller.edit("method", "Unary");
  h.controller.edit("target", "grpc://other:1");
  await assert.rejects(h.controller.run(), /先保存/);
  assert.equal(h.calls.length, 0);
});
test("concurrent click never starts a second call", async () => {
  const h = harness();
  ready(h);
  const p = h.controller.run();
  await assert.rejects(h.controller.run(), /尚未结束/);
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(receipt);
  await p;
});
test("unknown run does not retry, locks repeated send and keeps run id", async () => {
  const h = harness();
  ready(h);
  const p = h.controller.run();
  h.calls[0].reject(Error("transport lost"));
  await p;
  assert.equal(h.state.uncertain, true);
  assert.equal(h.state.lastRun.runId, "run-1");
  await assert.rejects(h.controller.run(), /结果未知/);
  assert.equal(h.calls.length, 1);
});
test("cancel targets same preallocated runId, never claims remote nonexecution", async () => {
  const h = harness();
  ready(h);
  const p = h.controller.run();
  await h.controller.cancel();
  await h.controller.cancel();
  assert.deepEqual(h.cancels, ["run-1"]);
  assert.match(h.state.notice, /不证明远端未执行/);
  h.calls[0].resolve(receipt);
  await p;
  assert.match(h.state.notice, /不证明远端未执行/);
  assert.equal(h.calls.length, 1);
});
test("invalidation clears credentials and preserves late result separately, not current result", async () => {
  const h = harness();
  ready(h);
  h.controller.edit("key", "PRIVATE");
  const p = h.controller.run();
  h.invalidate();
  assert.equal(h.state.key, "");
  assert.equal(h.state.metadata, "[]");
  h.calls[0].resolve(receipt);
  await p;
  assert.equal(h.state.result, null);
  assert.equal(h.state.lateResult.runId, "run-1");
  assert.equal(h.state.uncertain, true);
  assert.equal(h.state.lastRun.outcome, "late-receipt-needs-review");
});
test("explicit reflection list then schema does not invoke business methods", async () => {
  const h = harness();
  const p = h.controller.reflect();
  assert.equal(h.calls[0].action, "grpc-reflection");
  h.calls[0].resolve({
    runId: "run-1",
    status: { code: 0 },
    complete: true,
    services: [{ name: "Echo" }],
  });
  await p;
  assert.equal(h.state.reflectionService, "Echo");
  const q = h.controller.reflect("Echo");
  h.calls[1].resolve({
    ...schema,
    runId: "run-1",
    status: { code: 0 },
    complete: true,
    schema: { nested: {} },
  });
  await q;
  assert.deepEqual(h.state.definition.schema, { nested: {} });
  assert.equal(h.state.definition.proto, undefined);
  assert.equal(h.calls.length, 2);
});
test("incomplete reflection never admits schema", async () => {
  const h = harness();
  const p = h.controller.reflect("Echo");
  h.calls[0].resolve({
    ...schema,
    runId: "run-1",
    status: { code: 0 },
    complete: false,
    schema: {},
  });
  await p;
  assert.equal(h.state.schemaReady, false);
});
test("explicit file bundle bounded and no path reads; stale File.text cannot replace draft", async () => {
  const h = harness();
  await assert.rejects(
    h.controller.loadFiles({
      name: "../x.proto",
      size: 1,
      text: async () => "x",
    }),
    /根目录/,
  );
  let resolve;
  const p = h.controller.loadFiles({
    name: "main.proto",
    size: 5,
    text: () => new Promise((r) => (resolve = r)),
  });
  h.controller.edit("proto", "new draft");
  resolve("older file");
  await p;
  assert.equal(h.state.definition.proto, "new draft");
});
test("file source loads only explicit selected files then requires inspection", async () => {
  const h = harness();
  await h.controller.loadFiles(
    { name: "main.proto", size: 1, text: async () => "x" },
    [{ name: "dep.proto", size: 1, text: async () => "y" }],
  );
  assert.deepEqual(h.state.definition.files, { "dep.proto": "y" });
  assert.equal(h.state.schemaReady, false);
  assert.equal(h.calls.length, 0);
});
test("malformed run receipt is uncertain, not success", async () => {
  const h = harness();
  ready(h);
  const p = h.controller.run();
  h.calls[0].resolve({ ...receipt, runId: "wrong" });
  await p;
  assert.equal(h.state.result, null);
  assert.equal(h.state.uncertain, true);
});
test("render escapes remote details and payloads", () => {
  const h = harness();
  h.state.result = {
    messages: [{ text: "<script>" }],
    status: { details: "<img>" },
  };
  const html = renderGrpcUnary(h.state, []);
  assert(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});
test("editing pending run keeps receipt separately and disallows duplicate business calls", async () => {
  const h = harness();
  ready(h);
  const p = h.controller.run();
  h.controller.edit("message", '{"new":"draft"}');
  h.calls[0].resolve(receipt);
  await p;
  assert.equal(h.state.message, '{"new":"draft"}');
  assert.equal(h.state.result, null);
  assert.equal(h.state.lateResult.runId, "run-1");
  assert.equal(h.state.uncertain, true);
  await assert.rejects(h.controller.run(), /重新加载项目/);
  assert.equal(h.calls.length, 1);
});
test("selection does not erase unknown execution evidence; unsaved name edit is dirty", async () => {
  const h = harness();
  assert.equal(h.state.draftDirty, false);
  h.controller.edit("name", "new name");
  assert.equal(h.state.draftDirty, true);
  ready(h);
  const p = h.controller.run();
  h.calls[0].reject(Error("lost"));
  await p;
  h.controller.select("");
  assert.equal(h.state.lastRun.runId, "run-1");
  assert.equal(h.state.uncertain, true);
});
test("real schema and example contract with saved normalized definition", async () => {
  const { readFile } = await import("node:fs/promises");
  const { inspectGrpcSchema, normalizeGrpcDefinition } = await import(
    "../src/grpc.mjs"
  );
  const { generateGrpcRequestExample } = await import(
    "../src/grpc-request-example.mjs"
  );
  const proto = await readFile(
    new URL("./fixtures/grpc.proto", import.meta.url),
    "utf8",
  );
  const state = createGrpcUnaryState();
  let saved;
  const c = createGrpcUnaryController({
    state,
    definitions: [],
    post: async (action, body) =>
      action === "grpc-schema"
        ? inspectGrpcSchema(body)
        : generateGrpcRequestExample(body),
    saveDefinition: async (d) => (saved = normalizeGrpcDefinition(d)),
    assertCurrent() {},
    setBusy() {},
    uid: () => "real-definition",
  });
  c.edit("proto", proto);
  await c.inspect();
  assert(state.schemaReady);
  assert.equal(state.definition.service, "fixture.Echo");
  c.edit("method", "Unary");
  await c.example();
  assert.equal(JSON.parse(state.message).big, "0");
  await c.save();
  assert.equal(saved.service, "fixture.Echo");
  assert.equal(state.saved.id, "real-definition");
  assert.equal(state.draftDirty, false);
});
