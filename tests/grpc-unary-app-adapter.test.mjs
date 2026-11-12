import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProjectImportGuard } from "../public/project-import-guard.js";
import { createNativeRequestLifecycle } from "../public/native-request-lifecycle.js";
import {
  createGrpcUnaryState,
  selectGrpcUnary,
  createGrpcUnaryController,
} from "../public/grpc-unary-workbench.js";
const source = (
  await readFile(new URL("../public/app.js", import.meta.url), "utf8")
).replaceAll("\r\n", "\n");
const adapter = source.slice(
  source.indexOf("function bindGrpcWorkbench()"),
  source.indexOf("\nconst methodOptions"),
);
assert(adapter.startsWith("function bindGrpcWorkbench()"));
const definition = {
  id: "definition",
  name: "fixture",
  target: "grpc://localhost:50051",
  proto: "fixture",
  service: "Echo",
  method: "Unary",
  timeoutMs: 1000,
};
const receipt = {
  runId: "run-id",
  messages: [],
  status: { code: 0 },
  recordSaved: true,
};
function harness() {
  const state = createGrpcUnaryState();
  selectGrpcUnary(state, definition);
  state.schemaReady = true;
  state.services = [
    {
      name: "Echo",
      methods: [{ name: "Unary", requestStream: false, responseStream: false }],
    },
  ];
  const calls = [],
    guard = createProjectImportGuard();
  const api = (url, method, body) =>
    new Promise((resolve, reject) =>
      calls.push({ url, method, body, resolve, reject }),
    );
  const build = new Function(
    "state",
    "api",
    "projectImports",
    "nativeRequestLifecycle",
    "createGrpcUnaryController",
    `
 let project={id:'p',settings:{grpcDefinitions:[${JSON.stringify(definition)}]}},editVersion=0,page='grpc',grpcWorkbenchState=state,grpcNavigationGeneration=0,grpcBusyToken=null,busy=false,saving=false,dirty=false,controller,options,renders=0;
 const $=()=>({}),uid=()=> 'run-id',render=()=>renders++,confirm=()=>true;
 const bindGrpcUnary=(_,o)=>{options=o;controller=createGrpcUnaryController(o)};
 const mark=()=>{editVersion++;dirty=true};
 const save=async()=>{dirty=false};
 const rollbackProjectSave=()=>{};
 ${adapter}
 bindGrpcWorkbench();
 return {controller,options,leave(){page='apis'},edit(){editVersion++},project:()=>project,get busy(){return busy},get renders(){return renders}};
 `,
  );
  return {
    state,
    calls,
    guard,
    ...build(
      state,
      api,
      guard,
      createNativeRequestLifecycle(),
      createGrpcUnaryController,
    ),
  };
}
test("actual app adapter allows cancellation during execution without starting a second call", async () => {
  const h = harness(),
    p = h.controller.run();
  const cancel = h.controller.cancel();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].url, "/cancel");
  assert.equal(h.calls[1].body.id, "run-id");
  h.calls[1].resolve({ ok: true });
  await cancel;
  await h.controller.cancel();
  assert.equal(h.calls.length, 2);
  h.calls[0].resolve(receipt);
  await p;
  assert.equal(h.state.result.status.code, 0);
  assert.match(h.state.notice, /不证明远端未执行/);
});
test("actual app adapter displays known RPC receipt when recording fails and blocks new work until reload", async () => {
  const h = harness(),
    p = h.controller.run();
  h.calls[0].resolve({ ...receipt, recordSaved: false });
  await p;
  assert.equal(h.state.result.status.code, 0);
  assert.equal(h.state.result.recordSaved, false);
  assert.equal(h.state.lateResult, null);
  assert.equal(h.state.uncertain, false);
  assert.match(h.state.notice, /记录未保存/);
  assert.throws(() => h.guard.assertCanSave("p"), /重新加载/);
  await assert.rejects(h.controller.run(), /重新加载/);
  assert.equal(h.calls.length, 1);
});
test("actual app adapter retains unknown execution and does not repeat after connection loss", async () => {
  const h = harness(),
    p = h.controller.run();
  h.calls[0].reject(Error("connection lost"));
  await p;
  assert.equal(h.state.uncertain, true);
  assert.equal(h.state.lastRun.runId, "run-id");
  assert.match(h.state.notice, /调用结果未知/);
  await assert.rejects(h.controller.run(), /结果未知/);
  assert.throws(() => h.guard.assertCanSave("p"), /重新加载/);
  assert.equal(h.calls.length, 1);
});
for (const change of ["leave", "edit"])
  test(`actual app adapter does not apply RPC receipt after ${change}`, async () => {
    const h = harness(),
      p = h.controller.run();
    h[change]();
    h.calls[0].resolve(receipt);
    await p;
    assert.equal(h.state.result, null);
    assert.equal(h.state.lateResult.runId, "run-id");
    assert.equal(h.state.uncertain, true);
  });
test("actual app save adapter receives only definition, not temporary credentials or request message", async () => {
  const h = harness();
  h.controller.edit(
    "metadata",
    '[{"key":"authorization","value":"fixture-only"}]',
  );
  h.controller.edit("key", "fixture-private");
  h.controller.edit("message", '{"body":"fixture-body"}');
  await h.controller.save();
  const stored = JSON.stringify(h.project());
  for (const sentinel of ["fixture-only", "fixture-private", "fixture-body"])
    assert.equal(stored.includes(sentinel), false);
  assert.equal(h.state.saved.id, "definition");
});
