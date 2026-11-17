import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProjectImportGuard } from "../public/project-import-guard.js";
import { createNativeRequestLifecycle } from "../public/native-request-lifecycle.js";
import {
  createGrpcStreamState,
  createGrpcStreamController,
  invalidateGrpcStream,
} from "../public/grpc-stream-workbench.js";
const source = (
  await readFile(new URL("../public/app.js", import.meta.url), "utf8")
).replaceAll("\r\n", "\n");
const block = source.slice(
  source.indexOf("let grpcStreamState = null,"),
  source.indexOf("const methodOptions = ["),
);
const snap = (extra = {}) => ({
  id: "session",
  type: "grpc",
  lifecycle: "active",
  streaming: { request: true, response: true },
  requestState: "writable",
  messages: [],
  requestMessages: [],
  recordSaved: false,
  receiptState: null,
  ...extra,
});
const schema = {
  services: [
    {
      name: "fixture.S",
      methods: [{ name: "Chat", requestStream: true, responseStream: true }],
    },
  ],
};
async function passSchema(calls) {
  assert.match(calls[0].url, /grpc-schema$/);
  assert.deepEqual(calls[0].body, { proto: "PROTO_SOURCE" });
  calls[0].resolve(schema);
  await Promise.resolve();
  await Promise.resolve();
}
function harness() {
  const calls = [],
    storage = new Map(),
    guard = createProjectImportGuard();
  const api = (url, method, body) =>
    new Promise((resolve, reject) =>
      calls.push({ url, method, body, resolve, reject }),
    );
  const build = new Function(
    "api",
    "projectImports",
    "nativeRequestLifecycle",
    "createGrpcStreamState",
    "createGrpcStreamController",
    "invalidateGrpcStream",
    "storage",
    `
 let project={id:'p',settings:{grpcDefinitions:[{id:'def',name:'fixture',service:'fixture.S',method:'Chat',proto:'PROTO_SOURCE'}]}},editVersion=0,page='grpc',busy=false,saving=false,dirty=false,controller,options;
 const $=()=>({}),sessionStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 const bindGrpcStream=(_,o)=>{options=o;controller=createGrpcStreamController(o)};
 const render=()=>{syncGrpcStreamWorkbench();bindGrpcStreamWorkbench()};
 ${block}
 render();grpcStreamState.definitionId='def';
 return {get state(){return grpcStreamState},get controller(){return controller},get options(){return options},get busy(){return busy},leave(){page='apis';syncGrpcStreamWorkbench()},switchProject(){project={id:'other',settings:{grpcDefinitions:[]}};render()},reload(){project={...project};render()},restore(){const s=createGrpcStreamState();restoreGrpcStreamEvidence('p',s);return s}};
 `,
  );
  return {
    calls,
    storage,
    guard,
    r: build(
      api,
      guard,
      createNativeRequestLifecycle(),
      createGrpcStreamState,
      createGrpcStreamController,
      invalidateGrpcStream,
      storage,
    ),
  };
}
test("actual stream adapter cancels during pending send across render rebinding", async () => {
  const { r, calls } = harness();
  r.state.session = snap();
  r.state.sessionId = "session";
  const send = r.controller.send();
  assert.equal(calls.length, 1);
  const cancel = r.controller.cancel();
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /cancel$/);
  calls[1].resolve(
    snap({
      lifecycle: "terminal",
      requestState: "unavailable",
      recordSaved: true,
      receiptState: "saved",
    }),
  );
  await cancel;
  calls[0].resolve(snap());
  await send;
  assert.equal(r.busy, false);
  assert.ok(r.state.uncertainSessions.includes("session"));
  assert.equal(r.state.session.lifecycle, "terminal");
});
test("actual stream adapter allows read-only recovery after lost send while blocking new effects", async () => {
  const { r, calls, guard } = harness();
  r.state.session = snap();
  r.state.sessionId = "session";
  const send = r.controller.send();
  calls[0].reject(Error("lost"));
  await send;
  assert.throws(() => guard.assertCanSave("p"));
  const read = r.controller.poll();
  await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, undefined);
  calls[1].resolve(snap());
  await read;
  assert.ok(r.state.uncertainSessions.includes("session"));
  await assert.rejects(() => r.controller.send());
  assert.equal(calls.length, 2);
});
test("actual stream adapter persists only ids and uncertainty, never runtime credentials", async () => {
  const { r, calls, storage } = harness();
  r.state.metadata = '[{"key":"auth","value":"META_SECRET"}]';
  r.state.key = "KEY_SECRET";
  const start = r.controller.start();
  assert.equal(calls.length, 1);
  await passSchema(calls);
  assert.equal(r.restore().uncertainStart, true);
  calls[1].resolve(snap());
  await start;
  const text = [...storage.values()].join();
  assert.doesNotMatch(text, /META_SECRET|KEY_SECRET/);
  assert.equal(r.restore().sessionId, "session");
  r.leave();
  assert.equal(r.state.key, "");
  assert.equal(r.state.metadata, "[]");
});
test("actual stream adapter isolates late start from a different project", async () => {
  const { r, calls } = harness(),
    old = r.state;
  const start = r.controller.start();
  await passSchema(calls);
  r.switchProject();
  calls[1].resolve(snap());
  await start;
  assert.notEqual(r.state, old);
  assert.equal(r.state.session, null);
  assert.equal(old.uncertainStart, true);
  assert.equal(old.lateResult.id, "session");
});
test("failed terminal storage keeps project gate but permits explicit storage reconciliation", async () => {
  const { r, calls, guard } = harness();
  r.state.session = snap();
  r.state.sessionId = "session";
  const cancel = r.controller.cancel();
  calls[0].resolve(
    snap({
      lifecycle: "terminal",
      requestState: "unavailable",
      receiptState: "unknown",
    }),
  );
  await cancel;
  assert.throws(() => guard.assertCanSave("p"));
  assert.ok(r.state.persistenceProblems.includes("session"));
  const rec = r.controller.reconcile();
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /reconcile$/);
  calls[1].resolve(
    snap({
      lifecycle: "terminal",
      requestState: "unavailable",
      recordSaved: true,
      receiptState: "saved",
    }),
  );
  await rec;
  assert.equal(r.state.persistenceProblems.length, 0);
  assert.throws(() => guard.assertCanSave("p"));
});
test("restored known session must be read before a new start and cannot be hidden by editing id", async () => {
  const { r, calls } = harness();
  r.state.sessionId = "known-session";
  r.state.sessionIdKnown = true;
  await assert.rejects(() => r.controller.start());
  assert.equal(calls.length, 0);
  assert.throws(() => r.controller.edit("sessionId", ""));
  assert.equal(r.state.sessionId, "known-session");
});
test("actual adapter retains terminal unknown write despite confirmed record save", async () => {
  const { r, calls } = harness();
  r.state.session = snap();
  r.state.sessionId = "session";
  const send = r.controller.send();
  calls[0].resolve(
    snap({
      lifecycle: "terminal",
      requestState: "unavailable",
      recordSaved: true,
      receiptState: "saved",
      requestMessages: [{ sendState: "unknown" }],
    }),
  );
  await send;
  assert.ok(r.state.uncertainSessions.includes("session"));
  await assert.rejects(() => r.controller.start());
  assert.equal(calls.length, 1);
});
test("schema preflight rejects unary before execution uncertainty and never transmits credentials", async () => {
  const { r, calls, guard } = harness();
  r.state.metadata = '[{"key":"auth","value":"SECRET"}]';
  r.state.key = "PRIVATE";
  const start = r.controller.start();
  assert.deepEqual(calls[0].body, { proto: "PROTO_SOURCE" });
  calls[0].resolve({
    services: [
      {
        name: "fixture.S",
        methods: [
          { name: "Chat", requestStream: false, responseStream: false },
        ],
      },
    ],
  });
  await start;
  assert.equal(calls.length, 1);
  assert.equal(r.state.uncertainStart, false);
  assert.equal(r.busy, false);
  assert.doesNotThrow(() => guard.assertCanSave("p"));
  assert.match(r.state.notice, /单次调用/);
});
test("stale schema response cannot create a stream after navigation", async () => {
  const { r, calls } = harness();
  const start = r.controller.start();
  r.leave();
  calls[0].resolve(schema);
  await start;
  assert.equal(calls.length, 1);
  assert.equal(r.state.uncertainStart, false);
  assert.equal(r.busy, false);
});
test("manual unverified typo can be corrected without weakening restored operation ownership", async () => {
  const { r, calls } = harness();
  r.controller.edit("sessionId", "typo");
  const read = r.controller.poll();
  calls[0].reject(Error("not found"));
  await read;
  r.controller.edit("sessionId", "correct");
  assert.equal(r.state.sessionId, "correct");
  r.controller.edit("sessionId", "");
  assert.equal(r.state.sessionId, "");
  r.state.sessionId = "original";
  r.state.sessionIdKnown = true;
  r.options.persistEvidence(r.state);
  const restored = r.restore();
  assert.equal(restored.sessionIdKnown, true);
  Object.assign(r.state, restored);
  assert.throws(() => r.controller.edit("sessionId", "other"));
  await assert.rejects(() => r.controller.start());
  assert.equal(calls.length, 1);
});
test("restored pending stop cannot be hidden even when sessionIdKnown field is false", async () => {
  const { r } = harness();
  r.state.sessionId = "original";
  r.state.persistenceProblems = ["original"];
  r.options.persistEvidence(r.state);
  Object.assign(r.state, r.restore());
  assert.throws(() => r.controller.edit("sessionId", ""));
  await assert.rejects(() => r.controller.start());
});
