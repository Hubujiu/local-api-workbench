import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectImportGuard } from "../public/project-import-guard.js";
import { createNativeRequestLifecycle } from "../public/native-request-lifecycle.js";
import { createApp } from "../src/server.mjs";
import { normalizeRequest } from "../src/core.mjs";
const source = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const importSource = source.slice(
  source.indexOf('  on("#import",'),
  source.indexOf('  on("#export",'),
);
const openSource = source.slice(
  source.indexOf("async function openProject("),
  source.indexOf("\nfunction modal("),
);
const fixture = (id = "a") => ({
  id,
  name: "original",
  configRevision: 1,
  requests: [{ id: "r", name: "original" }],
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function harness({
  initial = fixture(),
  remote,
  mode = "interfaces",
  hooks = {},
} = {}) {
  const calls = [],
    guard = createProjectImportGuard(),
    native = createNativeRequestLifecycle();
  const api = (url, method = "GET", body) => {
    const d = deferred();
    const call = { url, method, body, ...d };
    calls.push(call);
    if (remote)
      Promise.resolve()
        .then(() => remote(call))
        .then(d.resolve, d.reject);
    return d.promise;
  };
  const create = new Function(
    "initial",
    "api",
    "projectImports",
    "nativeRequestLifecycle",
    "hooks",
    "importMode",
    `
    let project=initial,dirty=false,editVersion=0,busy=false,saving=false,modalRevision=1,projectOpenSequence=0,
      current="r",response=null,opened=[],page="apis",mode="design",projects=[{id:initial.id}],lastRun,loadResult,planId,selectedProtocolId;
    const els={"#import-mode":{value:importMode},"#import-file":{files:[]},"#import-text":{value:"{}"},"#import-directory":{files:[]},"#dialog":{open:true}};
    const $=s=>els[s], confirm=(text)=>hooks.confirm?.(text)??true, collect=()=>hooks.collect?.(), render=()=>{},toast=()=>{},request=()=>project.requests[0],sessionStorage={setItem(){}};
    const selectedDirectoryDocument=(files,options)=>hooks.directory?.(files,options)??{};
    const state=()=>({project,dirty,editVersion,busy,saving,projects});
    const edit=()=>{project.requests[0].name="new draft";dirty=true;editVersion++;};
    const save=async()=>{projectImports.assertCanSave(project.id);if(hooks.save)await hooks.save({state,edit});else{project={...project,configRevision:project.configRevision+1};dirty=false;}};
    ${openSource}
    let click,submit;const on=(s,e,f)=>click=f;const modal=(t,h,cb)=>submit=cb;
    ${importSource}
    click();
    return {run:()=>submit(),state,edit,els,save,open:openProject,replace(p){project=p;},dirty(){dirty=true;},setBusy(){busy=true;},selectPending(){projectOpenSequence++;},replaceModal(){modalRevision++;}};
  `,
  );
  return {
    ...create(initial, api, guard, native, hooks, mode),
    calls,
    guard,
    native,
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("actual merge callback applies its own response once", async () => {
  const h = harness();
  const running = h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "/projects/a/import");
  h.calls[0].resolve({ ...fixture(), requests: [{ id: "imported" }] });
  await running;
  assert.equal(h.state().project.requests[0].id, "imported");
  assert.equal(h.state().dirty, false);
});
test("pending import blocks duplicate POST, ordinary save and project open", async () => {
  const h = harness();
  const running = h.run();
  await assert.rejects(h.run(), /尚未完成/);
  await assert.rejects(h.save(), /尚未完成/);
  await assert.rejects(h.open("b"), /尚未完成/);
  assert.throws(() => h.guard.assertCanStart("a", "interfaces"), /尚未完成/);
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(fixture());
  await running;
});
for (const change of ["draft", "project", "close", "modal", "identity"]) {
  test(`actual import preserves ownership on ${change} after POST`, async () => {
    const h = harness();
    const running = h.run();
    if (change === "draft") h.edit();
    if (change === "project") h.replace(fixture("b"));
    if (change === "close") h.els["#dialog"].open = false;
    if (change === "modal") h.replaceModal();
    const before = h.state().project;
    h.calls[0].resolve(fixture(change === "identity" ? "wrong" : "a"));
    await assert.rejects(running, /核对/);
    assert.equal(h.state().project, before);
    if (change === "draft")
      assert.equal(h.state().project.requests[0].name, "new draft");
    assert.throws(() => h.guard.assertCanSave("a"), /重新加载/);
    assert.equal(h.calls.length, 1);
  });
}
test("unknown merge response never replays and only subsequent safe GET reconciles", async () => {
  const h = harness(),
    old = h.open("a");
  const running = h.run();
  h.calls[1].reject(Error("response lost"));
  await assert.rejects(running, /核对/);
  h.calls[0].resolve(fixture());
  await assert.rejects(old, /导入状态已变化/);
  assert.throws(() => h.guard.assertCanSave("a"), /重新加载/);
  await assert.rejects(h.run(), /重新加载/);
  assert.equal(h.calls.filter((c) => c.method === "POST").length, 1);
  const reload = h.open("a");
  h.calls.at(-1).resolve({ ...fixture(), configRevision: 2 });
  await reload;
  assert.doesNotThrow(() => h.guard.assertCanSave("a"));
});
test("new draft during reconciliation GET remains dirty and locked", async () => {
  const h = harness();
  const running = h.run();
  h.calls[0].reject(Error("lost"));
  await assert.rejects(running);
  const reload = h.open("a");
  h.edit();
  h.calls[1].resolve(fixture());
  await assert.rejects(reload, /草稿已变化/);
  assert.equal(h.state().dirty, true);
  assert.throws(() => h.guard.assertCanSave("a"), /重新加载/);
});
for (const kind of ["decline", "failure", "edit"]) {
  test(`draft-save ${kind} makes zero import requests`, async () => {
    const hooks =
      kind === "decline"
        ? { confirm: () => false }
        : {
            save: async ({ edit }) => {
              if (kind === "failure") throw Error("save failed");
              edit();
            },
          };
    const h = harness({ hooks });
    h.dirty();
    await assert.rejects(h.run());
    assert.equal(h.calls.length, 0);
    assert.equal(h.state().dirty, true);
    assert.doesNotThrow(() => h.guard.assertCanSave("a"));
  });
}
test("dirty draft save owned by import is permitted and settled before POST", async () => {
  const h = harness();
  h.dirty();
  const running = h.run();
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.state().project.configRevision, 2);
  h.calls[0].resolve({ ...fixture(), configRevision: 3 });
  await running;
});
for (const change of ["file", "text", "mode", "draft", "close"]) {
  test(`file read ${change} cancels before server write`, async () => {
    const d = deferred(),
      h = harness();
    h.els["#import-file"].files = [{ text: () => d.promise }];
    const running = h.run();
    if (change === "file") h.els["#import-file"].files = [];
    if (change === "text") h.els["#import-text"].value = "changed";
    if (change === "mode") h.els["#import-mode"].value = "restore";
    if (change === "draft") h.edit();
    if (change === "close") h.els["#dialog"].open = false;
    d.resolve("{}");
    await assert.rejects(running, /未执行导入/);
    assert.equal(h.calls.length, 0);
    assert.doesNotThrow(() => h.guard.assertCanSave("a"));
  });
}
test("unknown restore is not automatically retried or allowed to create duplicate copies", async () => {
  const h = harness({ mode: "restore" });
  const running = h.run();
  assert.equal(h.calls[0].url, "/restore");
  h.calls[0].reject(Error("response lost"));
  await assert.rejects(running, /检查项目列表/);
  await assert.rejects(h.run(), /避免重复/);
  assert.equal(h.calls.length, 1);
  assert.doesNotThrow(() => h.guard.assertCanSave("a"));
  assert.doesNotThrow(() => h.guard.assertCanStart("a", "interfaces"));
});
for (const change of ["draft", "project", "navigation"]) {
  test(`restore list response cannot replace ${change} ownership`, async () => {
    const h = harness({ mode: "restore" });
    const running = h.run();
    h.calls[0].resolve(fixture("restored"));
    await tick();
    assert.equal(h.calls[1].url, "/projects");
    if (change === "draft") h.edit();
    if (change === "project") h.replace(fixture("b"));
    if (change === "navigation") h.selectPending();
    const original = h.state().project;
    h.calls[1].resolve([{ id: "restored" }]);
    await assert.rejects(running, /未切换/);
    assert.equal(h.state().project, original);
    assert.equal(h.calls.length, 2);
    assert.throws(() => h.guard.assertCanStart("a", "restore"), /避免重复/);
  });
}
test("successful restore safely reloads the new copy without blocking its own GET", async () => {
  const h = harness({ mode: "restore" });
  const running = h.run();
  h.calls[0].resolve(fixture("restored"));
  await tick();
  h.calls[1].resolve([{ id: "restored" }]);
  await tick();
  assert.equal(h.calls[2].url, "/projects/restored");
  h.calls[2].resolve(fixture("restored"));
  await running;
  assert.equal(h.state().project.id, "restored");
});
test("finishing an older restore cannot clear a newer import's save gate ownership", async () => {
  const guard = createProjectImportGuard(),
    old = guard.begin("a", "restore");
  old.finish();
  const current = guard.begin("b", "interfaces"),
    d = deferred();
  const save = current.saveDraft(() => d.promise);
  old.finish();
  assert.doesNotThrow(() => guard.assertCanSave("b"));
  d.resolve();
  await save;
  assert.throws(() => guard.assertCanSave("b"), /尚未完成/);
  current.finish();
});
test(
  "real HTTP import commits once while the actual GUI callback preserves a newer draft",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "import-ui-ownership-"));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("original");
    p.requests.push(
      normalizeRequest({
        name: "Original request",
        url: "http://127.0.0.1/never-called",
      }),
    );
    await app.store.save(p);
    const d = deferred(),
      committed = deferred();
    let posts = 0;
    const h = harness({
      initial: p,
      remote: async (call) => {
        if (call.method === "POST") posts++;
        const response = await fetch(app.url + "/api" + call.url, {
          method: call.method,
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
          body: call.body ? JSON.stringify(call.body) : undefined,
        });
        assert.equal(response.status, 200);
        const value = await response.json();
        if (call.method === "POST") {
          committed.resolve(value);
          await d.promise;
        }
        return value;
      },
    });
    h.els["#import-text"].value = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "fixture", version: "1" },
      paths: {
        "/never-called": {
          get: {
            summary: "Imported request",
            responses: { 200: { description: "ok" } },
          },
        },
      },
    });
    const running = h.run();
    const diskValue = await committed.promise;
    h.edit();
    d.resolve();
    await assert.rejects(running, /草稿已变化/);
    assert.equal(h.state().project.requests[0].name, "new draft");
    assert.equal(h.state().dirty, true);
    assert.equal(posts, 1);
    assert.ok(
      (await app.store.get(p.id)).requests.some(
        (r) => r.name === "Imported request",
      ),
    );
    assert.ok(diskValue.requests.some((r) => r.name === "Imported request"));
    await assert.rejects(h.save(), /重新加载/);
    assert.equal(posts, 1);
  },
);

test("directory selection changes during parsing cancel before POST", async () => {
  const d = deferred(),
    h = harness({
      mode: "apipost-directory",
      hooks: { directory: () => d.promise },
    });
  h.els["#import-directory"].files = [{ name: "project.json" }];
  const running = h.run();
  h.els["#import-directory"].files = [{ name: "other.json" }];
  d.resolve({});
  await assert.rejects(running, /未执行导入/);
  assert.equal(h.calls.length, 0);
});
test("native lifecycle and imports cannot overlap through actual application dispatch", async () => {
  const h = harness(),
    d = deferred();
  const nativeProject = {
    id: "a",
    configRevision: 1,
    requests: [{ id: "r", nativeInheritance: {} }],
    settings: { nativeInheritance: {} },
  };
  const nativeRun = h.native.run({
    requestId: "r",
    restore: false,
    getState: () => ({
      project: nativeProject,
      dirty: false,
      editVersion: 0,
      busy: false,
      saving: false,
    }),
    collect() {},
    confirm: () => true,
    save: async () => {},
    post: () => d.promise,
    apply() {},
  });
  await assert.rejects(h.run(), /尚未完成/);
  assert.equal(h.calls.length, 0);
  d.resolve(nativeProject);
  await nativeRun;
  const pending = h.guard.begin("a", "interfaces");
  let calls = 0;
  const wrapper = source.slice(
    source.indexOf("async function changeNativeRequestLifecycle("),
    source.indexOf("async function openProject("),
  );
  const invoke = new Function(
    "project",
    "projectImports",
    "nativeRequestLifecycle",
    `${wrapper};return ()=>changeNativeRequestLifecycle("r",false);`,
  )(nativeProject, h.guard, {
    run() {
      calls++;
    },
  });
  await assert.rejects(invoke(), /尚未完成/);
  assert.equal(calls, 0);
  pending.finish();
});
