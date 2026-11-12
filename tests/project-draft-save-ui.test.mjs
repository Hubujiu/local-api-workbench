import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectImportGuard } from "../public/project-import-guard.js";
import { createApp } from "../src/server.mjs";
const source = (
  await readFile(new URL("../public/app.js", import.meta.url), "utf8")
).replaceAll("\r\n", "\n");
const saveCode = source.slice(
  source.indexOf("async function save()"),
  source.indexOf("\nfunction collect()"),
);
const openCode = source.slice(
  source.indexOf("async function openProject("),
  source.indexOf("\nfunction modal("),
);
const errorCode = source.slice(
  source.indexOf("function editErrorCode("),
  source.indexOf("\nfunction editMockField("),
);
const fixture = () => ({
  id: "a",
  name: "draft",
  revision: 1,
  configRevision: 1,
  _diskFingerprint: "one",
  updatedAt: "now",
  settings: { statusCodes: [{ code: 1, label: "old" }] },
  requests: [{ id: "r" }],
  documents: [],
  dictionary: [],
  environments: [],
  plans: [],
  cases: [],
  history: [],
  runs: [],
});
const saved = (value) => ({
  ...structuredClone(value),
  revision: value.revision + 1,
  configRevision: value.configRevision + 1,
  _diskFingerprint: "two",
});
function harness(initial = fixture(), transport) {
  const calls = [],
    guard = createProjectImportGuard();
  const api =
    transport ||
    ((url, method = "GET", data) =>
      new Promise((resolve, reject) =>
        calls.push({ url, method, data, resolve, reject }),
      ));
  const build = new Function(
    "initial",
    "api",
    "projectImports",
    `
 let project=initial,projects=[{id:initial.id}],editVersion=0,dirty=true,saving=false,busy=false,projectOpenSequence=0,current='r',opened=[],response,lastRun,loadResult,planId,selectedProtocolId;
 const nativeRequestLifecycle={assertCanSave(){},reloadCheckpoint(){return 0},assertReloadCurrent(){},acknowledgeReload(){}};
 let modalCallback, rendered;
 const fields={"#error-code-value":{value:"2"},"#error-code-label":{value:"candidate"},"#error-code-http":{checked:false}};
 const $=(key)=>fields[key],esc=String,modal=(_title,_html,fn)=>{modalCallback=fn};
 const document={querySelectorAll:()=>[]},sessionStorage={setItem(){}},collect=()=>{},render=()=>{rendered=structuredClone(project)},toast=()=>{},confirm=()=>true;
 const mark=()=>{dirty=true;editVersion++};
 ${saveCode}\n${openCode}\n${errorCode}
 return {save,open:openProject,editError(){editErrorCode(0);return modalCallback()},rendered:()=>rendered,edit(){project.name='new draft';mark()},replace(p){project=p;mark()},rollback:(e,fn)=>rollbackProjectSave(e,fn),state:()=>({project,dirty,saving}),mark};`,
  );
  return { ...build(initial, api, guard), guard, calls };
}
function rejection(id = "a", outcome = "not_committed") {
  return Object.assign(Error("rejected"), {
    projectCommitOutcome: {
      project_id: id,
      commit_outcome: outcome,
      retry_safe: false,
    },
  });
}
test("current valid receipt replaces only owned draft", async () => {
  const h = harness();
  const p = h.save();
  h.calls[0].resolve(saved(h.calls[0].data));
  await p;
  assert.equal(h.state().dirty, false);
  assert.equal(h.state().project.configRevision, 2);
});
test("valid late receipt advances metadata without erasing newer draft", async () => {
  const h = harness();
  const p = h.save();
  h.edit();
  h.calls[0].resolve(saved(h.calls[0].data));
  await p;
  assert.equal(h.state().project.name, "new draft");
  assert.equal(h.state().dirty, true);
  assert.equal(h.state().project.configRevision, 2);
});
test("same-ID new project object is not owned by old receipt", async () => {
  const h = harness();
  const p = h.save();
  const other = fixture();
  other.name = "other selection";
  h.replace(other);
  h.calls[0].resolve(saved(h.calls[0].data));
  await p;
  assert.equal(h.state().project, other);
  assert.equal(other.configRevision, 1);
});
for (const [name, mutate] of [
  ["only ID", () => ({ id: "a" })],
  ["same version", (x) => structuredClone(x)],
  ["wrong ID", (x) => ({ ...saved(x), id: "b" })],
  ["config skips", (x) => ({ ...saved(x), configRevision: 3 })],
  [
    "missing settings",
    (x) => {
      const y = saved(x);
      delete y.settings;
      return y;
    },
  ],
  [
    "missing snapshot field",
    (x) => {
      const y = saved(x);
      delete y.requests;
      return y;
    },
  ],
  ["invalid collection", (x) => ({ ...saved(x), plans: {} })],
])
  test(`invalid receipt: ${name} retains draft and blocks second PUT`, async () => {
    const h = harness();
    const owner = h.state().project,
      p = h.save();
    h.calls[0].resolve(mutate(h.calls[0].data));
    await assert.rejects(p, /尚未确认/);
    assert.equal(h.state().project, owner);
    assert.equal(h.state().dirty, true);
    await assert.rejects(h.save(), /重新加载/);
    assert.equal(h.calls.length, 1);
  });
test("runtime-only revision advance is allowed", async () => {
  const h = harness();
  const p = h.save();
  h.calls[0].resolve({ ...saved(h.calls[0].data), revision: 10 });
  await p;
  assert.equal(h.state().project.revision, 10);
});
test("owner projection may omit only declared internal histories", async () => {
  const initial = fixture();
  initial.requestDefinitionHistory = [];
  initial.loadRuns = [];
  const h = harness(initial),
    p = h.save();
  const value = saved(h.calls[0].data);
  delete value.requestDefinitionHistory;
  delete value.loadRuns;
  h.calls[0].resolve(value);
  await p;
  assert.equal(h.state().dirty, false);
});
test("explicit not committed may roll back only same owner/version", async () => {
  const h = harness(),
    p = h.save();
  h.calls[0].reject(rejection());
  let error;
  try {
    await p;
  } catch (e) {
    error = e;
  }
  let rolled = 0;
  assert.equal(
    h.rollback(error, () => rolled++),
    true,
  );
  assert.equal(rolled, 1);
});
test("explicit old rejection cannot roll back newer draft", async () => {
  const h = harness(),
    p = h.save();
  h.edit();
  h.calls[0].reject(rejection());
  let error;
  try {
    await p;
  } catch (e) {
    error = e;
  }
  assert.equal(
    h.rollback(error, () => {
      throw Error("must not rollback");
    }),
    false,
  );
  assert.equal(h.state().project.name, "new draft");
});
for (const error of [Error("lost"), rejection("a", "unknown"), rejection("b")])
  test(`uncertain rejection ${error.projectCommitOutcome?.commit_outcome || "transport"} preserves and locks`, async () => {
    const h = harness(),
      p = h.save();
    h.calls[0].reject(error);
    await assert.rejects(p, /尚未确认/);
    await assert.rejects(h.save(), /重新加载/);
    assert.equal(h.calls.length, 1);
  });
test("pending save is rejected rather than falsely acknowledged", async () => {
  const h = harness(),
    p = h.save();
  await assert.rejects(h.save(), /尚未完成/);
  h.calls[0].resolve(saved(h.calls[0].data));
  await p;
  assert.equal(h.calls.length, 1);
});
test("outer guarded save keeps shared operation ownership", async () => {
  const h = harness(),
    outer = h.guard.begin("a", "execution");
  const p = outer.saveDraft(h.save);
  h.calls[0].resolve(saved(h.calls[0].data));
  await p;
  assert.throws(() => h.guard.begin("a", "case"), /尚未完成/);
  outer.finish();
  h.guard.begin("a", "case").finish();
});
test("old GET cannot unlock failed PUT; fresh safe GET can", async () => {
  const h = harness();
  const open = h.open("a");
  const p = h.save();
  h.calls[1].reject(Error("lost"));
  await assert.rejects(p);
  h.calls[0].resolve(fixture());
  await assert.rejects(open, /状态已变化/);
  await assert.rejects(h.save(), /重新加载/);
  const next = h.open("a");
  h.calls[2].resolve(fixture());
  await next;
  const s = h.save();
  h.calls[3].resolve(saved(h.calls[3].data));
  await s;
});
test("all ten optimistic catch rollback sites use the common owner receipt", () => {
  assert.equal(
    (source.match(/rollbackProjectSave\(error, \(\) =>/g) || []).length,
    10,
  );
  assert.doesNotMatch(
    source,
    /catch \(error\) \{\s*project\.[^\n]+ = previous;/,
  );
});
test("real HTTP PUT commits once then dropped response retains draft and locks retry", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "draft-recovery-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const initial = await app.store.create("real draft");
  let puts = 0;
  const h = harness(initial, async (url, method = "GET", data) => {
    const r = await fetch(app.url + "/api" + url, {
      method,
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const b = await r.json();
    if (method === "PUT") {
      puts++;
      assert.equal(r.status, 200);
      throw Error("lost acknowledgement");
    }
    return b;
  });
  h.edit();
  await assert.rejects(h.save(), /尚未确认/);
  assert.equal((await app.store.get(initial.id)).name, "new draft");
  assert.equal(h.state().dirty, true);
  await assert.rejects(h.save(), /重新加载/);
  assert.equal(puts, 1);
  await h.open(initial.id);
  assert.equal(h.state().dirty, false);
});
test("actual error-code callback restores only rejected own draft and renders rollback", async () => {
  const h = harness();
  const p = h.editError();
  assert.equal(h.state().project.settings.statusCodes[0].label, "candidate");
  h.calls[0].reject(rejection());
  await assert.rejects(p, /rejected/);
  assert.equal(h.state().project.settings.statusCodes[0].label, "old");
  assert.equal(h.rendered().settings.statusCodes[0].label, "old");
});
test("actual error-code old rejection preserves newer draft", async () => {
  const h = harness();
  const p = h.editError();
  h.state().project.settings.statusCodes[0].label = "NEW";
  h.mark();
  h.calls[0].reject(rejection());
  await assert.rejects(p);
  assert.equal(h.state().project.settings.statusCodes[0].label, "NEW");
  assert.equal(h.state().dirty, true);
});
test("outer operation finish cannot clear unknown PUT reconciliation", async () => {
  const h = harness(),
    outer = h.guard.begin("a", "execution");
  const p = outer.saveDraft(h.save);
  h.calls[0].reject(Error("lost"));
  await assert.rejects(p);
  outer.finish();
  await assert.rejects(h.save(), /重新加载/);
  assert.equal(h.calls.length, 1);
});
test("different project GET never reconciles original unknown save", async () => {
  const h = harness();
  const p = h.save();
  h.calls[0].reject(Error("lost"));
  await assert.rejects(p);
  const next = h.open("b");
  h.calls[1].resolve({ ...fixture(), id: "b" });
  await next;
  assert.throws(() => h.guard.assertCanSave("a"), /重新加载/);
  h.guard.assertCanSave("b");
});
test("configuration revision can never exceed overall revision", async () => {
  const initial = fixture();
  initial.configRevision = 2;
  const h = harness(initial),
    p = h.save();
  h.calls[0].resolve({ ...saved(h.calls[0].data), revision: 2 });
  await assert.rejects(p, /尚未确认/);
});
