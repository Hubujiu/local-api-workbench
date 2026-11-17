import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const slice = (a, b) =>
  source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const helper = slice("function previewDraftOwner()", "function modal(");
const handlers =
  slice('  on("#import-parameter-dictionary",', '  on("[data-dynamic-pair]",') +
  slice('  on("#bulk-error-codes",', '  on("#mock-builtins",');
function harness(kind) {
  const build = new Function(
    "kind",
    `
 let project={id:'a',settings:{statusCodes:[{code:'old',label:'old'}]},parameterDictionary:[]},editVersion=0,modalRevision=0,busy=false,saving=false;
 let callback, calls=[], pending=[], handlers={},fail;
 const fields={'#dialog':{open:true},'#dictionary-format':{value:'kv'},'#dictionary-source':{value:'x: new'},'#error-codes-source':{value:''}};
 const $=key=>fields[key],collect=()=>{},esc=String;
 const nativeRequestLifecycle={assertCanSave(){}},projectImports={assertCanSave(){}};
 const document={querySelectorAll:()=>[{dataset:{importParameter:'0'}}]};
 const on=(key,event,fn)=>handlers[key]=fn;
 const modal=(title,html,fn)=>{modalRevision++;fields['#dialog'].open=true;callback=fn;};
 const mark=()=>editVersion++;
 const api=(url,method,data)=>new Promise((resolve,reject)=>{calls.push({url,method,data});pending.push({resolve,reject})});
 const save=async()=>{calls.push({url:project.id,method:'PUT'});if(fail)throw fail;};
 const rollbackProjectSave=(e,fn)=>{if(e?.projectSaveRollback?.owner===project&&e.projectSaveRollback.version===editVersion){fn();mark();}};
 ${helper}\n${handlers}
 return {open(){handlers[kind==='codes'?'#bulk-error-codes':'#import-parameter-dictionary']()},submit:()=>callback(),capture:()=>callback,resolve:(index=0)=>pending.splice(index,1)[0].resolve(kind==='codes'?{codes:[{code:'new',label:'new'}]}:[{entry:{key:'x',type:'string'}}]),bad:()=>pending.shift().resolve({}),calls,fields,state:()=>project,edit(){editVersion++},switch(){project={id:'b',settings:{statusCodes:[]},parameterDictionary:[]}},close(){fields['#dialog'].open=false},failUnknown(){fail=Error('unknown')},failRejected(){fail=Error('rejected');fail.projectSaveRollback={owner:project,version:editVersion+1}}};`,
  );
  return build(kind);
}
for (const kind of ["codes", "dictionary"]) {
  for (const change of ["switch", "edit", "close", "open"])
    test(`${kind}: late preview after ${change} cannot write`, async () => {
      const h = harness(kind);
      h.open();
      const p = h.submit();
      h[change]();
      h.resolve();
      await assert.rejects(p, /变化/);
      assert.equal(h.calls.length, 1);
    });
  test(`${kind}: changed source refuses late result`, async () => {
    const h = harness(kind);
    h.open();
    const p = h.submit();
    h.fields[
      kind === "codes" ? "#error-codes-source" : "#dictionary-source"
    ].value = "newer";
    h.resolve();
    await assert.rejects(p, /变化/);
    assert.equal(h.calls.length, 1);
  });
  test(`${kind}: malformed preview never writes`, async () => {
    const h = harness(kind);
    h.open();
    const p = h.submit();
    h.bad();
    await assert.rejects(p, /无效/);
    assert.equal(h.calls.length, 1);
  });
  test(`${kind}: happy path writes original project once`, async () => {
    const h = harness(kind);
    h.open();
    const p = h.submit();
    h.resolve();
    await p;
    if (kind === "dictionary") await h.submit();
    assert.equal(h.calls.filter((x) => x.method === "PUT").length, 1);
    assert.equal(h.calls.at(-1).url, "a");
  });
  test(`${kind}: unknown save retains imported draft and does not retry`, async () => {
    const h = harness(kind);
    h.open();
    h.failUnknown();
    const p = h.submit();
    h.resolve();
    if (kind === "codes") await assert.rejects(p, /unknown/);
    else {
      await p;
      await assert.rejects(h.submit(), /unknown/);
    }
    assert.equal(h.calls.length, 2);
    assert.equal(
      kind === "codes"
        ? h.state().settings.statusCodes[0].code
        : h.state().parameterDictionary[0].key,
      kind === "codes" ? "new" : "x",
    );
  });
  test(`${kind}: definite rejection restores prior value`, async () => {
    const h = harness(kind);
    h.open();
    h.failRejected();
    const p = h.submit();
    h.resolve();
    if (kind === "codes") await assert.rejects(p, /rejected/);
    else {
      await p;
      await assert.rejects(h.submit(), /rejected/);
    }
    assert.deepEqual(
      kind === "codes"
        ? h.state().settings.statusCodes
        : h.state().parameterDictionary,
      kind === "codes" ? [{ code: "old", label: "old" }] : [],
    );
  });
}
for (const change of ["switch", "edit", "close", "open"])
  test(`dictionary: confirmation after ${change} cannot write`, async () => {
    const h = harness("dictionary");
    h.open();
    const p = h.submit();
    h.resolve();
    await p;
    const confirm = h.capture();
    h[change]();
    await assert.rejects(confirm(), /变化/);
    assert.equal(h.calls.length, 1);
  });

test("dictionary: changed format refuses late preview", async () => {
  const h = harness("dictionary");
  h.open();
  const p = h.submit();
  h.fields["#dictionary-format"].value = "json";
  h.resolve();
  await assert.rejects(p, /变化/);
  assert.equal(h.calls.length, 1);
});
for (const kind of ["codes", "dictionary"]) {
  for (const reverse of [false, true])
    test(`${kind}: overlapping modal previews ${reverse ? "reverse" : "ordered"} completion`, async () => {
      const h = harness(kind);
      h.open();
      const old = h.submit();
      const rejected = assert.rejects(old, /变化/);
      h.open();
      const current = h.submit();
      if (reverse) {
        h.resolve(1);
        await current;
        h.resolve();
      } else {
        h.resolve();
        await rejected;
        h.resolve();
        await current;
      }
      await rejected;
      if (kind === "dictionary") await h.submit();
      assert.equal(h.calls.filter((x) => x.method === "PUT").length, 1);
    });
}
