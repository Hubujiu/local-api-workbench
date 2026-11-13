import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProjectImportGuard } from "../public/project-import-guard.js";
import { createNativeRequestLifecycle } from "../public/native-request-lifecycle.js";
import {
  createSocketIOState,
  selectSocketIO,
  createSocketIOController,
  invalidateSocketIO,
} from "../public/socketio-workbench.js";
const source = (
  await readFile(new URL("../public/app.js", import.meta.url), "utf8")
).replaceAll("\r\n", "\n");
const block = source.slice(
  source.indexOf("let socketioWorkbenchState = null,"),
  source.indexOf("let grpcWorkbenchState = null,"),
);
const definition = {
  id: "definition",
  name: "fixture",
  url: "http://localhost:3000/",
  path: "/socket.io/",
  events: null,
  version: 4,
  transport: "websocket",
};
const snapshot = {
  id: "session-id",
  type: "socketio",
  state: "open",
  events: [],
  definition,
};
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
    "createSocketIOState",
    "selectSocketIO",
    "createSocketIOController",
    "invalidateSocketIO",
    "storage",
    `
 let project={id:'p',settings:{socketioDefinitions:[${JSON.stringify(definition)}]}},editVersion=0,page='socketio',busy=false,saving=false,dirty=false,controller,options;
 const $=()=>({}),uid=()=> 'definition',confirm=()=>true;
 const sessionStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 const bindSocketIO=(_,o)=>{options=o;controller=createSocketIOController(o)};
 const render=()=>bindSocketIOWorkbench();
 const mark=()=>{editVersion++;dirty=true};const save=async()=>{dirty=false};const rollbackProjectSave=()=>{};
 ${block}
 syncSocketIOWorkbench();selectSocketIO(socketioWorkbenchState,project.settings.socketioDefinitions[0]);bindSocketIOWorkbench();
 return {get controller(){return controller},get options(){return options},get state(){return socketioWorkbenchState},leave(){page='apis';syncSocketIOWorkbench()},edit(){editVersion++},get busy(){return busy},project:()=>project,restore(){const s=createSocketIOState();restoreSocketIOEvidence('p',s);return s}};
 `,
  );
  return {
    calls,
    storage,
    guard,
    ...Object.fromEntries([]),
    runtime: build(
      api,
      guard,
      createNativeRequestLifecycle(),
      createSocketIOState,
      selectSocketIO,
      createSocketIOController,
      invalidateSocketIO,
      storage,
    ),
  };
}
test("actual Socket.IO adapter permits stop during pending send across render rebinding", async () => {
  const h = harness(),
    r = h.runtime;
  r.state.session = structuredClone(snapshot);
  r.state.event = "echo";
  const p = r.controller.send();
  assert.equal(h.calls.length, 1);
  const q = r.controller.stop();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].url, /\/stop$/);
  h.calls[1].resolve({ ...snapshot, state: "closed", recordSaved: true });
  await q;
  h.calls[0].resolve({ status: "disconnected", remoteOutcome: "unknown" });
  await p;
  assert.equal(r.busy, false);
  assert.deepEqual(r.state.uncertainSessions, ["session-id"]);
  await assert.rejects(() => r.controller.send());
  assert.equal(h.calls.length, 2);
});
test("actual adapter persists secret-free pending intent before start and preserves unknown after lost response", async () => {
  const h = harness(),
    r = h.runtime;
  r.state.auth = '{"token":"private"}';
  r.state.key = "secret-key";
  const p = r.controller.connect();
  const stored = [...h.storage.values()].join("");
  assert(!stored.includes("private"));
  assert(!stored.includes("secret-key"));
  assert.match(stored, /"uncertainStart":true/);
  h.calls[0].reject(Error("lost"));
  await p;
  assert.equal(r.state.uncertainStart, true);
  assert.equal(r.restore().uncertainStart, true);
  await assert.rejects(() => r.controller.connect());
  assert.equal(h.calls.length, 1);
});
test("actual adapter keeps successful start separate from connected and restores id without traffic", async () => {
  const h = harness(),
    r = h.runtime;
  const p = r.controller.connect();
  h.calls[0].resolve({ ...snapshot, state: "connecting" });
  await p;
  const saved = r.restore();
  assert.equal(saved.session.id, "session-id");
  assert.equal(saved.session.state, "connecting");
  assert.equal(h.calls.length, 1);
  await assert.rejects(() => r.controller.connect());
});
test("actual adapter allows stop and GET after execution uncertainty without new effect admission", async () => {
  const h = harness(),
    r = h.runtime;
  r.state.session = structuredClone(snapshot);
  const p = r.controller.send();
  h.calls[0].reject(Error("lost"));
  await p;
  const q = r.controller.stop();
  h.calls[1].resolve({ ...snapshot, state: "closed", recordSaved: false });
  await q;
  assert.match(r.state.notice, /未保存/);
  const list = r.controller.list();
  h.calls[2].resolve([]);
  await list;
  assert.equal(h.calls[2].method, undefined);
});
test("actual adapter definition save never carries runtime credentials or event body", async () => {
  const h = harness(),
    r = h.runtime;
  r.state.auth = '{"token":"private"}';
  r.state.key = "private";
  r.state.args = '["private"]';
  r.controller.edit("name", "new name");
  await r.controller.save();
  assert.equal(r.state.saved.name, "new name");
  assert(!JSON.stringify(r.project()).includes("private"));
});
test("actual adapter isolates late start and clears runtime inputs on navigation", async () => {
  const h = harness(),
    r = h.runtime;
  r.state.auth = '{"token":"private"}';
  const p = r.controller.connect();
  r.leave();
  h.calls[0].resolve(snapshot);
  await p;
  assert.equal(r.state.session, null);
  assert.equal(r.state.auth, "{}");
  assert.equal(r.state.uncertainStart, true);
});

test("standalone stop save failure retains reconciliation gate for new effects", async () => {
  const h = harness(),
    r = h.runtime;
  r.state.session = structuredClone(snapshot);
  const stop = r.controller.stop();
  h.calls[0].resolve({ ...snapshot, state: "closed", recordSaved: false });
  await stop;
  assert.throws(() => h.guard.assertCanSave("p"));
  await assert.rejects(() => r.controller.connect());
  assert.equal(h.calls.length, 1);
});
test("standalone stop lost response gates new effects but permits explicit recovery stop", async () => {
  const h = harness(),
    r = h.runtime;
  r.state.session = structuredClone(snapshot);
  const stop = r.controller.stop();
  h.calls[0].reject(Error("lost"));
  await stop;
  assert.throws(() => h.guard.begin("p", "execution"));
  const second = r.controller.stop();
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ ...snapshot, state: "closed", recordSaved: true });
  await second;
  assert.throws(() => h.guard.assertCanSave("p"));
});
test("recovery guard does not clear old uncertainty or bypass pending mutation", () => {
  const guard = createProjectImportGuard();
  const first = guard.begin("p", "execution");
  first.requireReconciliation();
  assert.throws(() => guard.beginRecovery("p"));
  assert.throws(() => guard.beginRecovery("other"));
  first.finish();
  const recovery = guard.beginRecovery("p");
  assert.throws(() => guard.begin("p", "save"));
  assert.throws(() => guard.begin("other", "execution"));
  assert.throws(() => guard.reloadCheckpoint());
  recovery.finish();
  assert.throws(() => guard.assertCanSave("p"));
  assert.doesNotThrow(() => guard.assertCanSave("other"));
});
test("actual adapter releases busy after send settles before parallel stop on rebound controller", async () => {
  const h = harness(),
    r = h.runtime;
  r.state.session = structuredClone(snapshot);
  r.state.event = "echo";
  const p = r.controller.send();
  const q = r.controller.stop();
  h.calls[0].resolve({
    status: "acknowledged",
    remoteOutcome: "acknowledged",
    args: [],
  });
  await p;
  assert.equal(r.busy, true);
  h.calls[1].resolve({ ...snapshot, state: "closed", recordSaved: false });
  await q;
  assert.equal(r.busy, false);
  assert.deepEqual(r.restore().stopProblems, ["session-id"]);
  assert.throws(() => h.guard.assertCanSave("p"));
});
test("stop uncertainty marker survives refresh before HTTP receipt", async () => {
  const h = harness(),
    r = h.runtime;
  r.state.session = structuredClone(snapshot);
  const stop = r.controller.stop();
  const restored = r.restore();
  assert.ok(restored.stopProblems.includes(snapshot.id));
  h.calls[0].resolve({ ...snapshot, state: "closed", recordSaved: true });
  await stop;
});
test("project switch never injects same-id definition from B into cached A state", async () => {
  const openSource = source.slice(
    source.indexOf("async function openProject("),
    source.indexOf("// A preview is read-only"),
  );
  const a = {
    id: "a",
    settings: { socketioDefinitions: [definition] },
    requests: [],
  };
  const b = {
    id: "b",
    settings: {
      socketioDefinitions: [
        { ...definition, url: "http://different.invalid/" },
      ],
    },
    requests: [],
  };
  const run = new Function(
    "initial",
    "loaded",
    "createSocketIOState",
    "selectSocketIO",
    "invalidateSocketIO",
    "createProjectImportGuard",
    "createNativeRequestLifecycle",
    `
    let project=initial,editVersion=0,dirty=false,busy=false,saving=false,projectOpenSequence=0,current,opened,response,lastRun,loadResult,planId,selectedProtocolId;
    let grpcWorkbenchState=null,grpcWorkbenchProject='',grpcNavigationGeneration=0;
    let socketioWorkbenchState=createSocketIOState(),socketioWorkbenchProject=project.id,socketioNavigationGeneration=0;
    selectSocketIO(socketioWorkbenchState,initial.settings.socketioDefinitions[0]);
    const savedState=socketioWorkbenchState;
    const projectImports=createProjectImportGuard(),nativeRequestLifecycle=createNativeRequestLifecycle();
    const confirm=()=>true, api=async()=>loaded, render=()=>{},sessionStorage={setItem(){}};
    ${openSource}
    return openProject(loaded.id).then(()=>savedState);
  `,
  );
  const state = await run(
    a,
    b,
    createSocketIOState,
    selectSocketIO,
    invalidateSocketIO,
    createProjectImportGuard,
    createNativeRequestLifecycle,
  );
  assert.equal(state.definition.url, definition.url);
});
function prepareIncoming(h) {
  const r = h.runtime;
  r.state.session = {
    ...structuredClone(snapshot),
    events: [{ direction: "received", ackId: "incoming" }],
  };
  r.state.incomingAckId = "incoming";
  r.state.incomingAckArgs = '[{"answer":"not-a-secret"}]';
  return r;
}
test("actual adapter admits explicit incoming ack and persists only identifiers before dispatch", async () => {
  const h = harness(),
    r = prepareIncoming(h);
  const p = r.controller.acknowledge();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "/projects/p/socketio-sessions/session-id/ack");
  const saved = JSON.parse(h.storage.get("socketio-evidence-v1:p"));
  assert.deepEqual(saved.uncertainSessions, ["session-id"]);
  assert(!JSON.stringify(saved).includes("not-a-secret"));
  h.calls[0].resolve({ acknowledged: true });
  await p;
  assert.equal(r.state.result.remoteOutcome, "unknown");
  await assert.rejects(r.controller.acknowledge());
  assert.equal(h.calls.length, 1);
});
test("actual ack lost response restores unknown and owner guard denies replay", async () => {
  const h = harness(),
    r = prepareIncoming(h);
  const p = r.controller.acknowledge();
  h.calls[0].reject(Error("network lost"));
  await p;
  assert.deepEqual(r.restore().uncertainSessions, ["session-id"]);
  await assert.rejects(r.controller.acknowledge());
  assert.throws(() => h.guard.assertCanSave("p"));
  assert.equal(h.calls.length, 1);
});
test("actual ack late result cannot mutate departed view and stop still dispatched", async () => {
  const h = harness(),
    r = prepareIncoming(h);
  const p = r.controller.acknowledge(),
    q = r.controller.stop();
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ ...snapshot, state: "closed", recordSaved: false });
  await q;
  r.leave();
  h.calls[0].resolve({ acknowledged: true });
  await p;
  assert.equal(r.state.result, null);
  assert.deepEqual(r.state.stopProblems, ["session-id"]);
});
