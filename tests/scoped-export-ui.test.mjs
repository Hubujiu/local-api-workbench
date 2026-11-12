import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as view from "../public/scoped-export-view.js";
const source = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const code = source.slice(
  source.indexOf("function previewDraftOwner()"),
  source.indexOf("function modal("),
);
const projectFixture = () => ({
  id: "p",
  name: "Source",
  configRevision: 1,
  requests: [
    { id: "a", name: "Selected", folder: "root/child" },
    { id: "b", name: "Unselected" },
  ],
});
function receipt(input, project) {
  return {
    projectId: project.id,
    format: input.format,
    configRevision: project.configRevision,
    documentBytes: 2,
    options: { modelNameMode: "namespaced", databaseMode: null },
    scope: {
      digest: "a".repeat(64),
      requested: input.selection.resources,
      included: [
        ...input.selection.resources,
        { kind: "globals", id: "configuration" },
      ],
      dependencies: [{ kind: "globals", id: "configuration" }],
      omitted: ["history", "plans"],
    },
    warnings: ["Exact server warning <static credentials>"],
  };
}
function harness() {
  const build = new Function(
    ...Object.keys(view),
    `let project=${JSON.stringify(projectFixture())},editVersion=0,modalRevision=0,dirty=false,busy=false,saving=false;
 const fields={'#dialog':{open:true},'#scoped-export-format':{value:'apipost'},'#scoped-export-rebind':{checked:false},'#scoped-export-accept':{checked:false}};
 let callback,selection=[0],calls=[],downloads=[];
 const root={querySelector:key=>fields[key],querySelectorAll:()=>selection.map(i=>({dataset:{exportResource:String(i)}}))};
 const $=key=>key==='#dialog-content'?root:fields[key],collect=()=>{};
 const nativeRequestLifecycle={assertCanSave(){}},projectImports={assertCanSave(){}};
 const modal=(title,html,fn)=>{modalRevision++;fields['#dialog'].open=true;fields['#scoped-export-accept'].checked=false;callback=fn;};
 const api=(url,method,data)=>new Promise((resolve,reject)=>calls.push({url,method,data,resolve,reject,owner:structuredClone(project)}));
 const download=(name,data)=>downloads.push({name,data});
 ${code}
 return {open:openScopedDefinitionExport,submit:()=>callback(),capture:()=>callback,calls,downloads,fields,select:x=>selection=x,edit(){editVersion++;dirty=true},switch(){project={...project,id:'q'}},close(){fields['#dialog'].open=false},state:()=>project};`,
  );
  return build(...Object.values(view));
}
async function ready(h) {
  h.open();
  const p = h.submit();
  const call = h.calls.at(-1);
  call.resolve(receipt(call.data, call.owner));
  await p;
  return receipt(call.data, call.owner);
}
test("resource inventory has inferred ancestor folders, live models and indivisible bundles, never credential values", () => {
  const project = {
    ...projectFixture(),
    requests: [...projectFixture().requests, { id: "dead", deletedAt: "now" }],
    dictionary: [{ id: "model", name: "Model" }],
    openapiComponents: { schemas: { extra: {} } },
    postmanCollections: { items: [] },
    settings: {
      grpcDefinitions: [{ id: "g", secret: "SECRET" }],
      password: "SECRET",
    },
  };
  const resources = view.scopedExportResources(project);
  assert(resources.some((r) => r.kind === "folder" && r.id === "root"));
  assert(resources.some((r) => r.kind === "model" && r.id === "extra"));
  assert(resources.some((r) => r.kind === "collection-bundle"));
  assert(!resources.some((r) => r.id === "dead"));
  assert(!JSON.stringify(resources).includes("SECRET"));
  assert(!view.scopedExportSelectionHTML(resources).includes("checked"));
});
test("confirmation renders exact escaped server warnings and exposes dependencies without automatic consent", () => {
  const input = {
    format: "apipost",
    selection: { resources: [{ kind: "api", id: "a" }] },
  };
  const p = receipt(input, projectFixture());
  const html = view.scopedExportConfirmationHTML(
    p,
    view.scopedExportResources(projectFixture()),
  );
  assert.match(html, /Exact server warning &lt;static credentials&gt;/);
  assert.match(html, /全局配置/);
  assert(!html.includes("checked"));
});
for (const action of ["edit", "switch", "close", "open"])
  test(`late preview after ${action} cannot open confirmation or download`, async () => {
    const h = harness();
    h.open();
    const old = h.capture();
    const p = old();
    h[action]();
    h.calls[0].resolve(receipt(h.calls[0].data, h.calls[0].owner));
    await assert.rejects(p, /变化|保存/);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.calls.length, 1);
  });
test("changed checkbox invalidates pending preview", async () => {
  const h = harness();
  h.open();
  const p = h.submit();
  h.select([1]);
  h.calls[0].resolve(receipt(h.calls[0].data, h.calls[0].owner));
  await assert.rejects(p, /选择或格式/);
  assert.equal(h.calls.length, 1);
});
test("empty selection and unsaved draft never save or send", async () => {
  const h = harness();
  h.open();
  h.select([]);
  await assert.rejects(h.submit(), /选择至少/);
  h.select([0]);
  h.edit();
  await assert.rejects(h.submit(), /变化|保存/);
  assert.equal(h.calls.length, 0);
});
test("Postman rejects non-API selection and explicit database option", () => {
  const resources = view.scopedExportResources(projectFixture());
  const fields = {
    "#scoped-export-format": { value: "postman-collection-v2.1" },
    "#scoped-export-rebind": { checked: false },
  };
  const root = {
    querySelector: (k) => fields[k],
    querySelectorAll: () => [
      {
        dataset: {
          exportResource: String(
            resources.findIndex((r) => r.kind === "globals"),
          ),
        },
      },
    ],
  };
  assert.throws(() => view.readScopedExportInput(root, resources), /仅支持/);
  root.querySelectorAll = () => [{ dataset: { exportResource: "0" } }];
  fields["#scoped-export-rebind"].checked = true;
  assert.throws(() => view.readScopedExportInput(root, resources), /重绑定/);
});
test("successful export requires unchecked consent then one exact accepted dependency request", async () => {
  const h = harness();
  const p = await ready(h);
  await assert.rejects(h.submit(), /明确接受/);
  assert.equal(h.calls.length, 1);
  h.fields["#scoped-export-accept"].checked = true;
  const downloading = h.submit();
  assert.deepEqual(h.calls[1].data.acceptedDependencies, p.scope.dependencies);
  await assert.rejects(h.submit(), /不会自动/);
  h.calls[1].resolve({ ...p, document: {} });
  await downloading;
  assert.equal(h.downloads.length, 1);
  await assert.rejects(h.submit(), /不会自动/);
  assert.equal(h.calls.length, 2);
});
for (const action of ["edit", "switch", "close", "open"])
  test(`late export after ${action} cannot download or replace current draft`, async () => {
    const h = harness();
    const p = await ready(h);
    h.fields["#scoped-export-accept"].checked = true;
    const result = h.submit();
    h[action]();
    h.calls[1].resolve({ ...p, document: {} });
    await assert.rejects(result, /变化|保存/);
    assert.equal(h.downloads.length, 0);
  });
test("withdrawn consent during export prevents file delivery", async () => {
  const h = harness();
  const p = await ready(h);
  h.fields["#scoped-export-accept"].checked = true;
  const result = h.submit();
  h.fields["#scoped-export-accept"].checked = false;
  h.calls[1].resolve({ ...p, document: {} });
  await assert.rejects(result, /撤回/);
  assert.equal(h.downloads.length, 0);
});
test("failed export never automatically retries nor issues duplicate request from the same preview", async () => {
  const h = harness();
  await ready(h);
  h.fields["#scoped-export-accept"].checked = true;
  const result = h.submit();
  h.calls[1].reject(Error("lost result"));
  await assert.rejects(result, /lost/);
  await assert.rejects(h.submit(), /不会自动/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.downloads.length, 0);
});
test("malformed preview / changed document or warnings fail closed", () => {
  const input = {
    format: "apipost",
    selection: { resources: [{ kind: "api", id: "a" }] },
  };
  const project = projectFixture(),
    p = receipt(input, project);
  view.assertScopedExportPreview(p, input, project);
  for (const patch of [
    { projectId: "wrong" },
    { configRevision: 2 },
    { document: {} },
    { warnings: [] },
    { scope: { ...p.scope, dependencies: [] } },
  ])
    assert.throws(() =>
      view.assertScopedExportPreview({ ...p, ...patch }, input, project),
    );
  for (const patch of [
    { document: { extra: "data" } },
    { warnings: ["changed"] },
    { scope: { ...p.scope, digest: "b".repeat(64) } },
  ])
    assert.throws(() =>
      view.assertScopedExportResult({ ...p, document: {}, ...patch }, p),
    );
});
test("Postman omissions stay explicit and invalid format options reject", () => {
  const project = projectFixture();
  const input = {
    format: "postman-collection-v2.1",
    selection: { resources: [{ kind: "api", id: "a" }] },
  };
  const p = {
    ...receipt(input, project),
    omittedConfiguration: {
      environments: [{ kind: "environment", id: "env" }],
      globalVariables: true,
      independentlyReplayable: false,
    },
  };
  view.assertScopedExportPreview(p, input, project);
  const html = view.scopedExportConfirmationHTML(p, [
    { kind: "environment", id: "env", name: "Production env" },
  ]);
  assert.match(html, /Production env/);
  assert.match(html, /存在，但不导出/);
  for (const patch of [
    { options: null },
    { options: { modelNameMode: "preserve", databaseMode: null } },
    {
      omittedConfiguration: {
        ...p.omittedConfiguration,
        independentlyReplayable: true,
      },
    },
    {
      omittedConfiguration: {
        ...p.omittedConfiguration,
        environments: [{ kind: "api", id: "env" }],
      },
    },
  ])
    assert.throws(() =>
      view.assertScopedExportPreview({ ...p, ...patch }, input, project),
    );
});
test("deleted model is not resurrected in choices by its backing schema", () => {
  const resources = view.scopedExportResources({
    ...projectFixture(),
    dictionary: [{ id: "dead", deletedAt: "now" }],
    openapiComponents: { schemas: { dead: {} } },
  });
  assert(!resources.some((r) => r.kind === "model" && r.id === "dead"));
});
