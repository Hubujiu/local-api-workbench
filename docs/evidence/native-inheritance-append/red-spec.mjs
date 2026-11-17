import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/runtime.mjs';
import {importIntoProject} from '../src/core.mjs';
import {nativeInheritanceFixture} from './fixtures/native-inheritance.mjs';
const sessionId='native-append-test';
async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'native-append-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new Store(root), p=await store.create('native');
 importIntoProject(p,nativeInheritanceFixture(),{inheritanceMode:'preserve'});
 await store.save(p);
 const source=nativeInheritanceFixture(); source.apis[1].target_id='added';
 source.apis[1].url='/added';
 return {root,store,p:await store.get(p.id),input:{format:'apipost',document:source,selection:{mode:'all'}}};
}
test('native create-only preview/apply retains existing definitions and concurrent activity', async t=>{
 const {root,store,p,input}=await fixture(t);
 const preview=await store.previewManualImport(p.id,input,{sessionId});
 assert.deepEqual(preview.blockers,[]); assert.equal(typeof preview.token,'string');
 assert.equal(JSON.stringify(preview).includes('disabled-child'),false);
 await store.append(p.id,'history',{id:'new-activity',status:'passed'});
 const receipts=await Promise.allSettled([store,new Store(root)].map(s=>s.applyManualImport(p.id,{input,token:preview.token},{sessionId})));
 assert.equal(receipts.filter(r=>r.status==='fulfilled').length,1);
 const saved=await store.get(p.id);
 assert.deepEqual(saved.requests[0],p.requests[0]);
 assert.deepEqual(saved.settings.nativeInheritance.projectLayer,p.settings.nativeInheritance.projectLayer);
 assert.deepEqual(saved.settings.nativeInheritance.folders,p.settings.nativeInheritance.folders);
 assert.equal(saved.requests.length,2); assert.equal(saved.history[0].id,'new-activity');
 assert.equal(saved.requests[1].id,preview.items.find(i=>i.kind==='api').targetId);
 assert.deepEqual(saved.environments,p.environments);
});
test('native append rejects semantic conflicts and unsupported policies without writes', async t=>{
 const {store,p,input}=await fixture(t);
 for (const change of [x=>x.document.project_id='foreign',x=>x.document.global.global_param.header.parameter[0].value='changed',x=>x.document.global.envs[0].name='changed',x=>x.document.apis[1].target_id='api',x=>x.document.apis[0].name='Moved',x=>x.policies={api:'url'},x=>x.folderMap={Group:'Elsewhere'},x=>x.document.samples=[{}]]) {
  const bad=structuredClone(input); change(bad);
  await assert.rejects(store.previewManualImport(p.id,bad,{sessionId}));
  assert.deepEqual(await store.get(p.id),p);
 }
});
