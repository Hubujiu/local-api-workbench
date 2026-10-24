import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
const input = () => ({
  variables: {},
  request: {
    url: "http://localhost/",
    headers: [
      {
        key: "X-One",
        value: "first",
        description: "keep",
        schema: { type: "string" },
      },
      { key: "x-one", value: "second" },
      { key: "Off", value: "hidden", enabled: false },
    ],
  },
});
test("Header one/all/idx/each return bounded live entries with case-insensitive lookup", async () => {
  const original = input();
  const result = await runScript(
    `
    const h=pm.request.headers;
    pm.test('identity',()=>pm.expect(h.one('X-ONE')).to.equal(h.idx(1)));
    pm.test('count',()=>pm.expect(h.count()).to.equal(3));
    h.one('X-ONE').value='changed';
    h.all()[0].update({value:'first changed',description:'new description'});
    h.each((entry)=>{if(entry.key==='Off')entry.disabled=false;});
    pm.test('missing',()=>pm.expect(h.one('missing')).to.equal(undefined));
  `,
    original,
  );
  assert.ok(result.tests.every((x) => x.passed));
  assert.deepEqual(
    result.request.headers.map((x) => x.value),
    ["first changed", "changed", "hidden"],
  );
  assert.equal(result.request.headers[2].enabled, true);
  assert.deepEqual(result.request.headers[0].schema, { type: "string" });
  assert.equal(original.request.headers[0].value, "first");
});
test("Header live updates are atomic and removed entries cannot mutate replacements", async () => {
  const result = await runScript(
    `
    const h=pm.request.headers, entry=h.one('x-one');
    for(const patch of [{value:'x'.repeat(65537)}, {disabled:'yes'}, {unknown:'x'}, {[Symbol('unknown')]:'x'}, Object.defineProperty({},'hidden',{value:'x'}), {value:String.fromCharCode(0xd800)}]) {
      try {entry.update(patch);throw Error('accepted');} catch(e) {if(e.message==='accepted')throw e;}
    }
    pm.test('unchanged',()=>pm.expect(entry.value).to.equal('second'));
    h.remove('x-one');h.add({key:'x-one',value:'replacement'});
    try{entry.value='stale';throw Error('accepted');}catch(e){if(e.message==='accepted')throw e;}
  `,
    input(),
  );
  assert.ok(result.tests.every((x) => x.passed));
  assert.equal(result.request.headers.at(-1).value, "replacement");
});

test("live Header changes reach HTTP without changing saved request definitions", async (t) => {
  const http = await import("node:http");
  const { runPlan, snapshotPlan } = await import("../src/core.mjs");
  const { executeRequest } = await import("../src/runtime.mjs");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.headers));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          ...input().request,
          url: "http://127.0.0.1:" + server.address().port,
          beforeScript:
            "pm.request.headers.one('X-ONE').value='wire';pm.request.headers.upsert({key:'x-one',value:'wire'});pm.request.headers.idx(2).disabled=false;",
        },
      },
    ],
  });
  const saved = structuredClone(plan),
    result = await runPlan(plan, {}, executeRequest);
  assert.equal(result.status, "passed", JSON.stringify(result));
  const body = JSON.parse(result.results[0].response.body);
  assert.equal(body["x-one"], "first, wire");
  assert.equal(body.off, "hidden");
  assert.deepEqual(plan, saved);
});

test("Header readers include disabled members and retain duplicate/case options without exposing mutable snapshots", async () => {
  const result = await runScript(
    `
    const h=pm.request.headers;
    pm.test('disabled member',()=>{pm.expect(h.get('OFF')).to.equal('hidden');pm.expect(h.has('off')).to.equal(true);pm.expect(h.one('OFF').valueOf()).to.equal('hidden');});
    pm.test('membership',()=>{pm.expect(h.has('x-one','first')).to.equal(true);pm.expect(h.has('X-ONE','second')).to.equal(true);pm.expect(h.has('x-one','absent')).to.equal(false);pm.expect(h.has(h.idx(0))).to.equal(true);pm.expect(h.has({key:'X-One',value:'first'})).to.equal(false);});
    pm.test('object options',()=>{pm.expect(h.toObject()).to.deep.equal({'x-one':['first','second'],off:'hidden'});pm.expect(h.toObject(true)).to.deep.equal({'x-one':['first','second']});pm.expect(h.toObject(false,true)).to.deep.equal({'X-One':'first','x-one':'second',Off:'hidden'});});
    const copy=h.toObject();copy['x-one'][0]='not live';pm.test('detached',()=>pm.expect(h.idx(0).value).to.equal('first'));
    const removed=h.one('off');h.remove('off');pm.test('removed identity',()=>pm.expect(h.has(removed)).to.equal(false));
  `,
    input(),
  );
  assert.ok(
    result.tests.every((x) => x.passed),
    JSON.stringify(result.tests),
  );
});

test("Header object output keeps an existing prototype-like name as literal data", async () => {
  const result = await runScript(
    "const obj=pm.request.headers.toObject();pm.test('literal key',()=>{pm.expect(Object.getPrototypeOf(obj)).to.equal(Object.prototype);pm.expect(Object.hasOwn(obj,'__proto__')).to.equal(true);pm.expect(obj.__proto__).to.equal('literal');});",
    {
      variables: {},
      request: {
        url: "http://localhost/",
        headers: [{ key: "__proto__", value: "literal" }],
      },
    },
  );
  assert.ok(
    result.tests.every((x) => x.passed),
    JSON.stringify(result.tests),
  );
});

test("Header iterators honor context, early stop, live identity and explicit reduction", async () => {
  const result = await runScript(
    `
    const h=pm.request.headers, context={prefix:'seen:',keys:[]};
    h.each(function(e,i){this.keys.push(this.prefix+e.key);return false;},context);
    pm.test('stop and context',()=>pm.expect(context.keys).to.deep.equal(['seen:X-One']));
    h.each(function(e){pm.expect(this).to.equal(pm.request);return false;});
    const names=h.map(function(e,i){pm.expect(this).to.equal(h);return i+':'+e.key;});
    pm.test('map',()=>pm.expect(names).to.deep.equal(['0:X-One','1:x-one','2:Off']));
    const selected=h.filter(function(e){return e.key.startsWith(this.prefix);},{prefix:'x-'});
    pm.test('filter identity',()=>pm.expect(selected[0]).to.equal(h.idx(1)));
    selected[0].value='filtered';
    pm.test('find',()=>pm.expect(h.find(e=>e.disabled)).to.equal(h.idx(2)));
    pm.test('missing',()=>pm.expect(h.find(e=>false)).to.equal(undefined));
    const joined=h.reduce(function(acc,e){pm.expect(this).to.equal(h);return acc+e.value+'|';},'');
    pm.test('reduce',()=>pm.expect(joined).to.equal('first|filtered|hidden|'));
    for(const method of ['each','map','filter','find','reduce']) {
      try { h[method]('key'); throw Error('accepted'); } catch(e) { if(e.message==='accepted')throw e; }
    }
  `,
    input(),
  );
  assert.equal(result.tests.length, 6);
  assert.ok(
    result.tests.every((x) => x.passed),
    JSON.stringify(result.tests),
  );
  assert.equal(result.request.headers[1].value, "filtered");
});

test("Header iterator snapshot excludes additions and callback errors remain failures", async () => {
  const result = await runScript(
    `
    const h=pm.request.headers;
    const keys=h.map(function(e,i){if(i===0)h.add({key:'Later',value:'new'});return e.key;});
    pm.test('snapshot',()=>pm.expect(keys).to.deep.equal(['X-One','x-one','Off']));
    pm.test('added',()=>pm.expect(h.count()).to.equal(4));
  `,
    input(),
  );
  assert.ok(result.tests.every((x) => x.passed));
  await assert.rejects(
    runScript(
      `pm.request.headers.map(()=>{throw Error('iterator sentinel');});`,
      input(),
    ),
    /iterator sentinel/,
  );
});

test("Header upsert edits only the last duplicate in place and preserves disabled state", async () => {
  const result = await runScript(
    `
    const h=pm.request.headers,first=h.idx(0),last=h.idx(1),off=h.one('Off');
    pm.test('updated result',()=>pm.expect(h.upsert({key:'X-ONE',value:'updated'})).to.equal(false));
    pm.test('duplicate identity',()=>{pm.expect(h.count()).to.equal(3);pm.expect(h.idx(0)).to.equal(first);pm.expect(h.idx(1)).to.equal(last);pm.expect(first.value).to.equal('first');pm.expect(last.value).to.equal('updated');});
    h.upsert({key:'OFF',value:'still hidden'});
    pm.test('disabled identity',()=>{pm.expect(h.one('off')).to.equal(off);pm.expect(off.disabled).to.equal(true);});
    pm.test('added result',()=>pm.expect(h.upsert({key:'New',value:0,disabled:true})).to.equal(true));
    pm.test('new scalar',()=>{pm.expect(h.get('New')).to.equal('0');pm.expect(h.one('New').disabled).to.equal(true);});
    for(const item of [{key:'X-ONE',value:'bad',unknown:true},{key:'X-ONE',value:'bad',[Symbol('hidden')]:true},Object.defineProperty({key:'X-ONE',value:'bad'},'hidden',{value:1}),{key:'X-ONE',value:'x'.repeat(65537)}])pm.expect(()=>h.upsert(item)).to.throw();
    pm.test('atomic',()=>pm.expect(last.value).to.equal('updated'));
  `,
    input(),
  );
  assert.ok(
    result.tests.every((x) => x.passed),
    JSON.stringify(result.tests),
  );
  assert.deepEqual(
    result.request.headers.map((x) => x.value),
    ["first", "updated", "still hidden", "0"],
  );
  assert.equal(result.request.headers[2].enabled, false);
});

test("Header removal accepts member identity or bounded predicate and indexOf chooses last duplicate", async () => {
  const result = await runScript(
    `
    const h=pm.request.headers,first=h.idx(0),last=h.idx(1);
    pm.test('index',()=>{pm.expect(h.indexOf('X-ONE')).to.equal(1);pm.expect(h.indexOf(first)).to.equal(0);pm.expect(h.indexOf({key:'X-One'})).to.equal(-1);pm.expect(h.indexOf('missing')).to.equal(-1);});
    h.remove(first);
    pm.test('identity removal',()=>{pm.expect(h.count()).to.equal(2);pm.expect(h.one('x-one')).to.equal(last);pm.expect(h.indexOf(first)).to.equal(-1);});
    h.remove(function(e){pm.expect(this).to.equal(h);return e.disabled;});
    pm.test('predicate removal',()=>pm.expect(h.toObject()).to.deep.equal({'x-one':'second'}));
    h.add({key:'other',value:'keep'});
    h.remove(function(e){return e.key===this.name;},{name:'x-one'});
    pm.test('explicit context',()=>pm.expect(h.toObject()).to.deep.equal({other:'keep'}));
    h.remove(first);pm.expect(h.count()).to.equal(1);
    pm.expect(()=>h.remove(()=>{throw Error('predicate sentinel')})).to.throw('predicate sentinel');
    pm.test('failed selection',()=>pm.expect(h.count()).to.equal(1));
    try{first.value='stale';throw Error('accepted');}catch(e){if(e.message==='accepted')throw e;}
  `,
    input(),
  );
  assert.ok(
    result.tests.every((x) => x.passed),
    JSON.stringify(result.tests),
  );
  assert.deepEqual(
    result.request.headers.map((x) => x.key),
    ["other"],
  );
});

test("Header add preserves bounded descriptions and rejects invalid additions atomically", async () => {
  const result = await runScript(
    `
    const h=pm.request.headers;
    h.add({key:'Described',value:false,description:'retained',disabled:true});
    pm.test('metadata',()=>{pm.expect(h.one('Described').description).to.equal('retained');pm.expect(h.get('Described')).to.equal('false');pm.expect(h.one('Described').disabled).to.equal(true);});
    for(const item of [{key:'bad',value:'x',unknown:1},{key:'bad',value:'x',[Symbol('hidden')]:1},Object.defineProperty({key:'bad',value:'x'},'hidden',{value:1}),{key:'bad',disabled:'false'},{key:'bad',value:'x'.repeat(65537)},{key:'bad',description:'x'.repeat(8193)}])pm.expect(()=>h.add(item)).to.throw();
    pm.test('atomic',()=>pm.expect(h.count()).to.equal(4));
  `,
    input(),
  );
  assert.ok(
    result.tests.every((x) => x.passed),
    JSON.stringify(result.tests),
  );
  assert.equal(result.request.headers.at(-1).description, "retained");
});
