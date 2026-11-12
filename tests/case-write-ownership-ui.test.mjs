import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProjectImportGuard } from "../public/project-import-guard.js";
import { createNativeRequestLifecycle } from "../public/native-request-lifecycle.js";
const source = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const editSource = source.slice(
  source.indexOf("  async function editInterfaceCase("),
  source.indexOf("  function editCaseFolder("),
);
const openSource = source.slice(
  source.indexOf("async function openProject("),
  source.indexOf("\nfunction modal("),
);
const fixture = (id = "a") => ({
  id,
  configRevision: 1,
  requests: [{ id: "r", name: "original", body: "" }],
  cases: [],
});
function harness({ initial = fixture(), hooks = {} } = {}) {
  const calls = [],
    guard = createProjectImportGuard(),
    native = createNativeRequestLifecycle();
  const api = (url, method = "GET", body) =>
    new Promise((resolve, reject) =>
      calls.push({ url, method, body, resolve, reject }),
    );
  const create = new Function(
    "initial",
    "hooks",
    "api",
    "projectImports",
    "nativeRequestLifecycle",
    `
 let project=initial,current="r",editVersion=0,projectOpenSequence=0,modalRevision=0,dirty=false,busy=false,saving=false,opened=[],response,lastRun,loadResult,planId,selectedProtocolId;
 const els={"#case-name":{value:"new case"},"#case-folder":{value:""},"#modal-json":{value:JSON.stringify(initial.requests[0])},"#dialog":{open:true}};
 const $=s=>els[s],esc=s=>s,jsonEditor=()=>"",caseFolderPath=()=>"",collect=()=>{},render=()=>{},toast=()=>{},sessionStorage={setItem(){}},confirm=()=>hooks.confirm??true,request=()=>project.requests.find(r=>r.id===current);
 const edit=()=>{project.requests[0].name="new draft";dirty=true;editVersion++};
 const save=async()=>{projectImports.assertCanSave(project.id);nativeRequestLifecycle.assertCanSave(project.id);const version=editVersion;if(hooks.save)await hooks.save({edit});project={...project,configRevision:project.configRevision+1};if(version===editVersion)dirty=false};
 let submit;const modal=(t,h,cb)=>{modalRevision++;submit=cb};
 ${openSource}
 ${editSource}
 editInterfaceCase();
 return {run:()=>submit(),open:openProject,save,edit,els,state:()=>({project,dirty}),replace(p){project=p},replaceModal(){modalRevision++},dirty(){dirty=true},pendingNavigation(){projectOpenSequence++}};
 `,
  );
  return {
    ...create(initial, hooks, api, guard, native),
    calls,
    guard,
    native,
  };
}
test("case POST response preserves a newer project draft", async () => {
  const h = harness(),
    running = h.run();
  h.edit();
  h.calls[0].resolve({ project: fixture() });
  await assert.rejects(running, /用例可能已写入/);
  assert.equal(h.state().project.requests[0].name, "new draft");
});
test("case POST response cannot jump from project b back to a", async () => {
  const h = harness(),
    running = h.run();
  h.replace(fixture("b"));
  h.calls[0].resolve({ project: fixture() });
  await assert.rejects(running, /用例可能已写入/);
  assert.equal(h.state().project.id, "b");
});
test("owned case response applies exactly once", async () => {
  const h = harness(),
    run = h.run();
  assert.equal(h.calls[0].url, "/projects/a/cases");
  assert.equal(h.calls[0].body.sourceRequestId, "r");
  const saved = { ...fixture(), configRevision: 2, cases: [{ id: "c" }] };
  h.calls[0].resolve({ project: saved });
  await run;
  assert.equal(h.state().project, saved);
  assert.equal(h.state().dirty, false);
});
for (const change of ["close", "modal", "identity", "navigation"]) {
  test(`case response cannot replace changed ${change}`, async () => {
    const h = harness(),
      run = h.run();
    const before = h.state().project;
    if (change === "close") h.els["#dialog"].open = false;
    if (change === "modal") h.replaceModal();
    if (change === "navigation") h.pendingNavigation();
    h.calls[0].resolve({
      project: fixture(change === "identity" ? "wrong" : "a"),
    });
    await assert.rejects(run, /用例可能已写入/);
    assert.equal(h.state().project, before);
    assert.throws(() => h.guard.assertCanSave("a"), /核对用例保存结果/);
  });
}
test("pending case blocks duplicate, ordinary save, reload and import", async () => {
  const h = harness(),
    run = h.run();
  await assert.rejects(h.run(), /用例保存尚未完成/);
  await assert.rejects(h.save(), /用例保存尚未完成/);
  await assert.rejects(h.open("b"), /用例保存尚未完成/);
  assert.throws(() => h.guard.begin("a", "interfaces"), /用例保存尚未完成/);
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve({ project: fixture() });
  await run;
});
test("pending import prevents case POST", async () => {
  const h = harness(),
    operation = h.guard.begin("a", "interfaces");
  await assert.rejects(h.run(), /导入尚未完成/);
  assert.equal(h.calls.length, 0);
  operation.finish();
});
test("unknown case cannot replay and old GET cannot reconcile it", async () => {
  const h = harness(),
    old = h.open("a"),
    run = h.run();
  h.calls[1].reject(Error("lost response"));
  await assert.rejects(run, /用例可能已写入/);
  await assert.rejects(h.run(), /核对用例保存/);
  await assert.rejects(h.save(), /核对用例保存/);
  h.calls[0].resolve(fixture());
  await assert.rejects(old, /用例保存状态已变化/);
  const reload = h.open("a");
  h.calls[2].resolve({ ...fixture(), configRevision: 2 });
  await reload;
  assert.doesNotThrow(() => h.guard.assertCanSave("a"));
  assert.equal(h.calls.filter((c) => c.method === "POST").length, 1);
});
test("new draft while reconciliation is pending retains dirty state and lock", async () => {
  const h = harness(),
    run = h.run();
  h.calls[0].reject(Error("lost"));
  await assert.rejects(run);
  const reload = h.open("a");
  h.edit();
  h.calls[1].resolve(fixture());
  await assert.rejects(reload, /草稿已变化/);
  assert.equal(h.state().project.requests[0].name, "new draft");
  assert.throws(() => h.guard.assertCanSave("a"), /核对用例保存/);
});
for (const reason of ["decline", "failure", "edit", "input"]) {
  test(`draft save ${reason} never submits case`, async () => {
    const hooks = {
      confirm: reason !== "decline",
      save: async ({ edit }) => {
        if (reason === "failure") throw Error("save failed");
        if (reason === "edit") edit();
        if (reason === "input") h.els["#case-name"].value = "changed";
      },
    };
    const h = harness({ hooks });
    h.dirty();
    await assert.rejects(h.run());
    assert.equal(h.calls.length, 0);
  });
}
test("an owned dirty-save can finish before one case POST", async () => {
  const h = harness();
  h.dirty();
  const run = h.run();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 1);
  assert.equal(h.state().project.configRevision, 2);
  h.calls[0].resolve({ project: fixture() });
  await run;
});
test("old modal cannot submit into a different project", async () => {
  const h = harness();
  h.replace(fixture("b"));
  await assert.rejects(h.run(), /窗口已变化/);
  assert.equal(h.calls.length, 0);
});
test("case payload is parsed before any draft save and malformed input makes no write", async () => {
  let saves = 0;
  const h = harness({ hooks: { save: async () => saves++ } });
  h.dirty();
  h.els["#modal-json"].value = "{";
  await assert.rejects(h.run());
  assert.equal(saves, 0);
  assert.equal(h.calls.length, 0);
});
test("real case endpoint commits once even when GUI receives a late response", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { normalizeRequest } = await import("../src/core.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "case-write-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("case source");
  p.requests.push(
    normalizeRequest({
      id: "r",
      name: "original",
      url: "http://127.0.0.1:1/never-called",
    }),
  );
  await app.store.save(p);
  const h = harness({ initial: structuredClone(p) }),
    run = h.run(),
    call = h.calls[0];
  const response = await fetch(app.url + "/api" + call.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-token": app.token },
    body: JSON.stringify(call.body),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal((await app.store.get(p.id)).cases.length, 1);
  h.edit();
  call.resolve(result);
  await assert.rejects(run, /用例可能已写入/);
  assert.equal(h.state().project.requests[0].name, "new draft");
  await assert.rejects(h.run(), /核对用例保存/);
  assert.equal(h.calls.length, 1);
  assert.equal((await app.store.get(p.id)).cases.length, 1);
});
