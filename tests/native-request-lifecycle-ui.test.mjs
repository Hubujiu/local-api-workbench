import test from "node:test";
import { createProjectImportGuard } from "../public/project-import-guard.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createNativeRequestLifecycle,
  nativeRequestLifecycleOperation,
} from "../public/native-request-lifecycle.js";
import {
  validateNativeInheritanceProject,
  editNativeInheritance,
  assertNativeInheritanceIdentity,
} from "../src/native-inheritance.mjs";
import { assertAPIResourceTrashIdentity } from "../src/api-resource-restore.mjs";
const layer = () => ({
  auth: { mode: "none" },
  headers: [],
  query: [],
  cookies: [],
  form: [],
});
function fixture() {
  const p = {
    id: "fixture",
    name: "synthetic",
    configRevision: 1,
    requests: [
      {
        id: "r1",
        name: "one",
        method: "GET",
        url: "http://127.0.0.1/never-called",
        folder: "Group",
        auth: { type: "none" },
        headers: [],
        query: [],
        cookies: [],
        form: [],
        nativeInheritance: {
          sourceProjectId: "source",
          sourceId: "api",
          authMode: "none",
        },
      },
    ],
    folders: ["Group"],
    settings: {
      nativeInheritance: {
        version: 1,
        sourceProjectId: "source",
        projectLayer: layer(),
        folders: [
          {
            sourceId: "folder",
            parentId: "0",
            name: "Group",
            path: "Group",
            layer: layer(),
          },
        ],
        bindings: [{ requestId: "r1", sourceId: "api", parentId: "folder" }],
      },
    },
    plans: [],
    cases: [],
    history: [],
    runs: [],
    documents: [],
    protocols: [],
  };
  validateNativeInheritanceProject(p);
  return p;
}
function harness(p = fixture()) {
  let disk = structuredClone(p);
  const state = {
    project: structuredClone(p),
    dirty: false,
    editVersion: 0,
    busy: false,
    saving: false,
  };
  const controller = createNativeRequestLifecycle(),
    calls = [],
    confirmations = [];
  const options = {
    requestId: "r1",
    restore: false,
    getState: () => state,
    collect() {},
    confirm(m) {
      confirmations.push(m);
      return true;
    },
    async save() {
      controller.assertCanSave(state.project.id);
      disk = structuredClone(state.project);
      disk.configRevision++;
      state.project = structuredClone(disk);
      state.dirty = false;
    },
    async post(path, method, input) {
      calls.push({ path, method, input });
      assert.equal(input.configRevision, disk.configRevision);
      const ctx = {
        deletedAt: "2026-11-12T00:00:00.000Z",
        batchId: "batch-one",
        nativeTrash: input.operation.type === "recycle-folder",
      };
      const next = editNativeInheritance(disk, input.operation, ctx);
      assertNativeInheritanceIdentity(disk, next, input.operation, ctx);
      assertAPIResourceTrashIdentity(disk, next);
      next.configRevision++;
      disk = next;
      return structuredClone(next);
    },
    apply(next) {
      state.project = next;
      state.dirty = false;
    },
  };
  return {
    state,
    controller,
    options,
    calls,
    confirmations,
    get disk() {
      return disk;
    },
    run(restore = false) {
      return controller.run({ ...options, restore });
    },
  };
}
test("native delete/restore uses explicit revisioned commands; no optimistic mutation", async () => {
  const h = harness();
  assert.equal(await h.run(), true);
  assert(h.state.project.requests[0].deletedAt);
  assert.equal(h.calls[0].input.configRevision, 1);
  assert.deepEqual(h.calls[0].input.operation, {
    type: "recycle-requests",
    requestIds: ["r1"],
  });
  assert.equal(await h.run(true), true);
  assert.equal(h.state.project.requests[0].deletedAt, undefined);
  assert.equal(h.calls[1].input.configRevision, 2);
});
test("dirty draft saved first and command uses returned revision without losing values", async () => {
  const h = harness();
  h.state.project.requests[0].name = "unsaved";
  h.state.dirty = true;
  await h.run();
  assert.equal(h.disk.requests[0].name, "unsaved");
  assert.equal(h.calls[0].input.configRevision, 2);
  assert.equal(h.confirmations.length, 2);
});
test("declining lifecycle or draft save makes no command and preserves draft", async () => {
  for (const declineAt of [1, 2]) {
    const h = harness();
    h.state.dirty = true;
    h.state.project.requests[0].name = "draft";
    let n = 0;
    h.options.confirm = () => ++n !== declineAt;
    assert.equal(await h.run(), false);
    assert.equal(h.calls.length, 0);
    assert.equal(h.state.project.requests[0].name, "draft");
    assert.equal(h.state.dirty, true);
  }
});
test("save failure or new edits during save prevent lifecycle command", async () => {
  for (const failure of [true, false]) {
    const h = harness();
    h.state.dirty = true;
    h.options.save = async () => {
      if (failure) throw Error("disk write failed");
      h.state.editVersion++;
      h.state.dirty = true;
    };
    await assert.rejects(h.run());
    assert.equal(h.calls.length, 0);
    assert.equal(h.state.dirty, true);
  }
});
test("revision conflict/lost response require explicit reload and block later ordinary save", async () => {
  for (const message of ["项目已有其他修改，请重新加载", "connection lost"]) {
    const h = harness();
    const before = structuredClone(h.state.project);
    h.options.post = async () => {
      throw Error(message);
    };
    await assert.rejects(h.run(), /未确认/);
    assert.deepEqual(h.state.project, before);
    assert.throws(() => h.controller.assertCanSave("fixture"), /重新加载/);
    await assert.rejects(h.run(), /重新加载/);
    h.controller.acknowledgeReload("fixture", h.controller.reloadCheckpoint());
    assert.doesNotThrow(() => h.controller.assertCanSave("fixture"));
  }
});
test("pending double click and ordinary save blocked; late draft kept and future save blocked", async () => {
  const h = harness();
  let release;
  const original = h.options.post;
  h.options.post = async (...args) => {
    await new Promise((r) => (release = r));
    return original(...args);
  };
  const first = h.run();
  await assert.rejects(h.run(), /尚未完成/);
  assert.throws(() => h.controller.assertCanSave("fixture"), /尚未完成/);
  h.state.project.requests[0].name = "newer";
  h.state.dirty = true;
  h.state.editVersion++;
  release();
  await assert.rejects(first, /服务器已完成/);
  assert(h.disk.requests[0].deletedAt);
  assert.equal(h.state.project.requests[0].deletedAt, undefined);
  assert.equal(h.state.project.requests[0].name, "newer");
  assert.throws(() => h.controller.assertCanSave("fixture"), /重新加载/);
  assert.equal(h.calls.length, 1);
});
test("success arriving after project switch preserves other project and blocks source save", async () => {
  const h = harness();
  let release;
  const original = h.options.post;
  h.options.post = async (...args) => {
    await new Promise((r) => (release = r));
    return original(...args);
  };
  const first = h.run();
  h.state.project = { ...fixture(), id: "other" };
  release();
  await assert.rejects(first, /服务器已完成/);
  assert.equal(h.state.project.id, "other");
  assert.throws(() => h.controller.assertCanSave("fixture"), /重新加载/);
  assert.doesNotThrow(() => h.controller.assertCanSave("other"));
});
test("recycled folder member restores entire confirmed batch, never single request", async () => {
  const p = fixture();
  p.requests.push({
    ...structuredClone(p.requests[0]),
    id: "r2",
    nativeInheritance: {
      sourceProjectId: "source",
      sourceId: "api2",
      authMode: "none",
    },
  });
  p.settings.nativeInheritance.bindings.push({
    requestId: "r2",
    sourceId: "api2",
    parentId: "folder",
  });
  validateNativeInheritanceProject(p);
  const op = { type: "recycle-folder", sourceId: "folder" },
    ctx = {
      deletedAt: "2026-11-12T00:00:00.000Z",
      batchId: "batch-one",
      nativeTrash: true,
    };
  const recycled = editNativeInheritance(p, op, ctx);
  assertNativeInheritanceIdentity(p, recycled, op, ctx);
  assertAPIResourceTrashIdentity(p, recycled);
  const intent = nativeRequestLifecycleOperation(recycled, "r1", true);
  assert.deepEqual(intent.operation, {
    type: "restore-folder",
    batchId: "batch-one",
  });
  assert.match(intent.confirmation, /Group/);
  assert.match(intent.confirmation, /2 个接口/);
  const canceled = harness(recycled);
  canceled.options.confirm = () => false;
  await canceled.run(true);
  assert.equal(canceled.calls.length, 0);
  const h = harness(recycled);
  await h.run(true);
  assert(h.state.project.requests.every((r) => !r.deletedAt));
  assert.deepEqual(h.state.project.folders, ["Group"]);
  assert.deepEqual(h.calls[0].input.operation, intent.operation);
});
test("backend plain-save protection remains intact for the original GUI mutations", () => {
  const p = fixture(),
    changed = structuredClone(p);
  changed.requests[0].deletedAt = "2026-11-12T00:00:00.000Z";
  assert.throws(
    () => assertNativeInheritanceIdentity(p, changed),
    /普通保存不能切换回收状态/,
  );
  const op = { type: "recycle-requests", requestIds: ["r1"] },
    ctx = { deletedAt: changed.requests[0].deletedAt };
  const archived = editNativeInheritance(p, op, ctx),
    restored = structuredClone(archived);
  delete restored.requests[0].deletedAt;
  assert.throws(
    () => assertNativeInheritanceIdentity(archived, restored),
    /普通保存不能切换回收状态/,
  );
});
test("actual application wiring awaits native controller and guards ordinary saves/reloads", async () => {
  const app = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  assert.match(
    app,
    /if \(project\) nativeRequestLifecycle\.assertCanSave\(project.id\)/,
  );
  const handlers = app.slice(
    app.indexOf('  on("#delete",'),
    app.indexOf('  on("#send",'),
  );
  const execute = new Function(
    "project",
    "changeNativeRequestLifecycle",
    "confirm",
    "request",
    "mark",
    "render",
    "save",
    "responses",
    `let current="r1",response;const handlers={};const on=(s,e,f)=>handlers[s]=f;${handlers};return handlers;`,
  );
  const calls = [];
  const p = fixture();
  let marks = 0;
  const native = execute(
    p,
    async (...x) => calls.push(x),
    () => true,
    () => p.requests[0],
    () => marks++,
    () => {},
    async () => {},
    new Map(),
  );
  await native["#delete"]();
  await native["[data-restore]"](null, { dataset: { restore: "r1" } });
  assert.deepEqual(calls, [
    ["r1", false],
    ["r1", true],
  ]);
  assert.equal(marks, 0);
  assert.equal(p.requests[0].deletedAt, undefined);
  const ordinary = fixture();
  delete ordinary.settings.nativeInheritance;
  delete ordinary.requests[0].nativeInheritance;
  let saved = 0;
  const old = execute(
    ordinary,
    () => {
      throw Error("wrong branch");
    },
    () => true,
    () => ordinary.requests[0],
    () => marks++,
    () => {},
    async () => saved++,
    new Map(),
  );
  await old["#delete"]();
  assert(ordinary.requests[0].deletedAt);
  await old["[data-restore]"](null, { dataset: { restore: "r1" } });
  assert.equal(ordinary.requests[0].deletedAt, undefined);
  assert.equal(saved, 1);
});

async function openHarness(
  initial = fixture(),
  controller = createNativeRequestLifecycle(),
) {
  const app = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const source = app.slice(
    app.indexOf("async function openProject("),
    app.indexOf("\nfunction modal("),
  );
  const gets = [];
  const api = (path) =>
    new Promise((resolve, reject) => gets.push({ path, resolve, reject }));
  const create = new Function(
    "initial",
    "nativeRequestLifecycle",
    "projectImports",
    "api",
    `
    let project=initial, dirty=false, editVersion=0, busy=false, saving=false,
      projectOpenSequence=0,current,opened,response,lastRun,loadResult,planId,selectedProtocolId;
    const confirm=()=>true,sessionStorage={setItem(){}},render=()=>{};
    ${source}
    return {open:openProject,getState:()=>({project,dirty,editVersion,busy,saving}),
      edit(){project.requests[0].name="new draft";dirty=true;editVersion++;},
      replace(p){project=p;},flag(key){if(key==="busy")busy=true;else saving=true;}};
  `,
  );
  return {
    ...create(initial, controller, createProjectImportGuard(), api),
    gets,
    controller,
  };
}
async function unknownCommand(h) {
  await assert.rejects(
    h.controller.run({
      requestId: "r1",
      restore: false,
      getState: h.getState,
      collect() {},
      confirm: () => true,
      save: async () => {},
      post: async () => {
        throw Error("response lost");
      },
      apply() {
        throw Error("must not apply");
      },
    }),
    /未确认/,
  );
}
test("actual openProject delayed GET never replaces a newer draft or releases needsReload", async () => {
  const h = await openHarness();
  await unknownCommand(h);
  const pending = h.open("fixture");
  h.edit();
  h.gets[0].resolve(fixture());
  await assert.rejects(pending, /草稿已变化/);
  assert.equal(h.getState().project.requests[0].name, "new draft");
  assert.equal(h.getState().dirty, true);
  assert.throws(() => h.controller.assertCanSave("fixture"), /重新加载/);
});
test("actual openProject only newest GET applies, across opposite response orders", async () => {
  for (const newerFirst of [true, false]) {
    const h = await openHarness();
    const first = h.open("first"),
      second = h.open("second");
    if (newerFirst) {
      h.gets[1].resolve({ ...fixture(), id: "second" });
      await second;
      h.gets[0].resolve({ ...fixture(), id: "first" });
    } else {
      h.gets[0].resolve({ ...fixture(), id: "first" });
      await first;
      assert.equal(h.getState().project.id, "fixture");
      h.gets[1].resolve({ ...fixture(), id: "second" });
    }
    await Promise.all([first, second]);
    assert.equal(h.getState().project.id, "second");
  }
});
test("actual openProject rejects replacement identity and new busy/save work", async () => {
  for (const changed of ["identity", "busy", "saving"]) {
    const h = await openHarness(),
      pending = h.open("fixture");
    if (changed === "identity") h.replace({ ...fixture(), id: "other" });
    else h.flag(changed);
    h.gets[0].resolve(fixture());
    await assert.rejects(pending, /项目或草稿已变化/);
    assert.equal(
      h.getState().project.id,
      changed === "identity" ? "other" : "fixture",
    );
  }
});
test("actual openProject ignores a wrong response identity without clearing reload lock", async () => {
  const h = await openHarness();
  await unknownCommand(h);
  const pending = h.open("fixture");
  h.gets[0].resolve({ ...fixture(), id: "wrong" });
  await assert.rejects(pending, /身份不匹配/);
  assert.equal(h.getState().project.id, "fixture");
  assert.throws(() => h.controller.assertCanSave("fixture"), /重新加载/);
});
test("actual old GET cannot reconcile a later unknown POST; only subsequent safe GET unlocks", async () => {
  const h = await openHarness();
  const old = h.open("fixture"),
    oldSnapshot = fixture();
  await unknownCommand(h);
  h.gets[0].resolve(oldSnapshot);
  await assert.rejects(old, /回收\/恢复状态已变化/);
  assert.throws(() => h.controller.assertCanSave("fixture"), /重新加载/);
  const fresh = h.open("fixture"),
    server = editNativeInheritance(
      fixture(),
      { type: "recycle-requests", requestIds: ["r1"] },
      { deletedAt: "2026-11-12T00:00:00.000Z" },
    );
  server.configRevision = 2;
  h.gets[1].resolve(server);
  await fresh;
  assert(h.getState().project.requests[0].deletedAt);
  assert.equal(h.getState().dirty, false);
  assert.doesNotThrow(() => h.controller.assertCanSave("fixture"));
});
test("actual openProject cannot start reconciliation while a lifecycle command is pending", async () => {
  const h = await openHarness();
  let finish;
  const command = h.controller.run({
    requestId: "r1",
    restore: false,
    getState: h.getState,
    collect() {},
    confirm: () => true,
    save: async () => {},
    post: () => new Promise((r) => (finish = r)),
    apply(p) {
      h.replace(p);
    },
  });
  await assert.rejects(h.open("fixture"), /尚未完成/);
  assert.equal(h.gets.length, 0);
  const result = editNativeInheritance(
    fixture(),
    { type: "recycle-requests", requestIds: ["r1"] },
    { deletedAt: "2026-11-12T00:00:00.000Z" },
  );
  result.configRevision = 2;
  finish(result);
  await command;
});
test("native-trash single-request history is retained when restoring through explicit graph action", async () => {
  const p = fixture(),
    op = { type: "recycle-requests", requestIds: ["r1"] },
    ctx = {
      deletedAt: "2026-11-12T00:00:00.000Z",
      nativeTrash: true,
      batchId: "native-batch",
    };
  const archived = editNativeInheritance(p, op, ctx);
  assertAPIResourceTrashIdentity(p, archived);
  const h = harness(archived),
    history = structuredClone(archived.apiResourceTrash);
  await h.run(true);
  assert.deepEqual(h.state.project.apiResourceTrash, history);
  assert.equal(h.state.project.requests[0].deletedAt, undefined);
});
