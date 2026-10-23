import test from "node:test";
import assert from "node:assert/strict";
import { runScript, runScriptSequence } from "../src/scripts.mjs";

test("script form collections preserve duplicate text values, disabled rows, live entries and detached arrays", async () => {
  for (const mode of ["urlencoded", "formdata"]) {
    const result = await runScript(
      `
      pm.request.body.update({ mode: '${mode}', ${mode}: [
        { key: 'tag', value: 'first' }, { key: 'tag', value: 'last', disabled: true }, { key: '__proto__', value: 'literal' }
      ] });
      const form = pm.request.body.${mode};
      pm.test('read collection', () => {
        pm.expect(form.count()).to.equal(3);
        pm.expect(form.get('tag')).to.equal('last');
        pm.expect(form.has('tag', 'first')).to.equal(true);
        pm.expect(form.toObject().tag).to.deep.equal(['first', 'last']);
        pm.expect(form.toObject(true).tag).to.equal('first');
        pm.expect(form.toObject()['__proto__']).to.equal('literal');
        const array = form.all(); array.pop(); pm.expect(form.count()).to.equal(3);
        const entry = form.one('tag'); entry.value = 'live-last';
        pm.expect(form.get('tag')).to.equal('live-last');
        form.all()[0].value = 'temporary';
        form.each(row => { if (row.key === 'tag' && !row.disabled) row.value = 'first'; });
        entry.key = 'renamed'; pm.expect(form.get('tag')).to.equal('first');
        pm.expect(form.get('renamed')).to.equal('live-last');
        entry.update({key:'tag',value:'last'});
        pm.expect(() => { entry.value = {}; }).to.throw();
        pm.expect(form.get('tag')).to.equal('last');
      });
      pm.expect(form.upsert({key:'tag',value:'changed'})).to.equal(false);
      pm.expect(form.upsert({key:'new',value:'0'})).to.equal(true);
      form.add({key:'new',value:''});
      form.remove('__proto__');
      pm.test('updated collection', () => {
        pm.expect(form.get('tag')).to.equal('changed');
        pm.expect(form.one('tag').disabled).to.equal(true);
        pm.expect(form.idx(0).value).to.equal('first');
        pm.expect(form.count()).to.equal(4);
      });
    `,
      { request: {} },
    );
    assert(
      result.tests.every((x) => x.passed),
      JSON.stringify(result.tests),
    );
    assert.equal(
      result.request.bodyType,
      mode === "formdata" ? "form-data" : mode,
    );
    assert.deepEqual(
      result.request.form.map((x) => [x.key, x.value, x.enabled]),
      [
        ["tag", "first", true],
        ["tag", "changed", false],
        ["new", "0", true],
        ["new", "", true],
      ],
    );
  }
});

test("form updates reject unsupported data and preserve valid state atomically", async () => {
  const result = await runScript(
    `
    pm.request.body.update({mode:'urlencoded',urlencoded:[{key:'keep',value:'yes'}]});
    const form = pm.request.body.urlencoded;
    for (const item of [{key:'x',value:{}},{key:'x',value:1},{key:'x',value:'x',src:'/etc/passwd'},{key:'x',type:'file',value:'x'},{key:'x',value:'x',disabled:'false'},{key:'x',value:'\\ud800'}])
      pm.expect(() => form.add(item)).to.throw();
    pm.expect(() => form.add({key:'x',value:'你'.repeat(21846)})).to.throw();
    pm.expect(() => pm.request.body.update({mode:'urlencoded',urlencoded:[{key:'new',value:'value'},{key:'bad',value:{}}]})).to.throw();
    pm.expect(() => pm.request.body.update({mode:'urlencoded',urlencoded:'a=b'})).to.throw();
    pm.expect(() => pm.request.body.update({mode:'formdata',formdata:[{key:'file',type:'file',src:'/etc/passwd'}]})).to.throw();
    pm.test('atomic', () => pm.expect(form.toObject()).to.deep.equal({keep:'yes'}));
    pm.request.body.update({mode:'formdata',formdata:[]});
    pm.expect(() => form.add({key:'stale',value:'x'})).to.throw();
    pm.expect(() => pm.request.body.formdata.add({key:'bad\\r\\nname',value:'x'})).to.throw();
    pm.request.body.formdata.add({key:'valid',value:'a\\nb'});
  `,
    { request: {} },
  );
  assert(
    result.tests.every((x) => x.passed),
    JSON.stringify(result.tests),
  );
  assert.deepEqual(
    result.request.form.map((x) => [x.key, x.value]),
    [["valid", "a\nb"]],
  );
});

test("existing uploaded file references remain opaque and cannot be overwritten by text upsert", async () => {
  const upload = {
    key: "upload",
    type: "file",
    filename: "chosen.txt",
    value: "c2FmZQ==",
    enabled: true,
  };
  const request = {
    bodyType: "form-data",
    form: [upload, { key: "note", type: "text", value: "old", enabled: true }],
  };
  const result = await runScript(
    `
    const form = apt.request.body.formdata;
    pm.test('opaque file', () => {
      pm.expect(form.has('upload')).to.equal(true);
      pm.expect(form.get('upload')).to.equal(undefined);
      pm.expect(form.one('upload')).to.deep.equal({key:'upload',type:'file',filename:'chosen.txt',disabled:false});
      pm.expect(form.one('upload').value).to.equal(undefined);
    });
    pm.expect(() => form.upsert({key:'upload',value:'replacement'})).to.throw();
    pm.expect(() => { form.one('upload').value = 'replacement'; }).to.throw();
    form.upsert({key:'note',value:'updated'});
  `,
    { request },
  );
  assert(
    result.tests.every((x) => x.passed),
    JSON.stringify(result.tests),
  );
  assert.deepEqual(result.request.form[0], upload);
  assert.equal(result.request.form[1].value, "updated");
  assert.equal(request.form[1].value, "old");
});

test("form lists enforce entry and aggregate UTF-8 budgets without resetting shared-stage state", async () => {
  const result = await runScriptSequence(
    [
      {
        name: "project",
        code: "pm.request.body.update({mode:'urlencoded',urlencoded:[]}); pm.request.body.urlencoded.add({key:'scope',value:'project'});",
      },
      {
        name: "request",
        code: "pm.expect(pm.request.body.urlencoded.get('scope')).to.equal('project'); pm.request.body.urlencoded.upsert({key:'scope',value:'request'});",
      },
    ],
    { request: {} },
  );
  assert.equal(result.request.form[0].value, "request");
  await assert.rejects(
    runScript(
      "pm.request.body.update({mode:'urlencoded',urlencoded:Array.from({length:1001},(_,i)=>({key:'k'+i,value:''}))})",
      { request: {} },
    ),
    /1000/,
  );
  await assert.rejects(
    runScript(
      "pm.request.body.update({mode:'urlencoded',urlencoded:Array.from({length:5},(_,i)=>({key:'k'+i,value:'x'.repeat(65536)}))})",
      { request: {} },
    ),
    /256KiB/,
  );
});

test("form byte boundaries and replacing a body invalidate old collections without losing new data", async () => {
  const out = await runScript(
    `
    pm.request.body.update({mode:'urlencoded',urlencoded:Array.from({length:4},(_,i)=>({key:'p'+i,value:'x'.repeat(65534)}))});
    const old = pm.request.body.urlencoded;
    pm.expect(old.count()).to.equal(4);
    pm.expect(() => old.add({key:'p4',value:''})).to.throw();
    pm.request.body.update({mode:'urlencoded',urlencoded:[{key:'new',value:'kept'}]});
    pm.expect(() => old.clear()).to.throw();
    pm.expect(pm.request.body.urlencoded.get('new')).to.equal('kept');
    pm.request.body.urlencoded.clear();
    pm.expect(pm.request.body.urlencoded.count()).to.equal(0);
    pm.request.body.update({mode:'raw',raw:'unchanged raw'});
    pm.expect(pm.request.body.urlencoded).to.equal(undefined);
  `,
    { request: {} },
  );
  assert.equal(out.request.bodyType, "raw");
  assert.equal(out.request.body, "unchanged raw");
});

test("scripted urlencoded and multipart forms execute as real HTTP including the unchanged selected upload", async (t) => {
  const http = await import("node:http");
  const { runPlan, snapshotPlan } = await import("../src/core.mjs");
  const { executeRequest } = await import("../src/runtime.mjs");
  const received = [];
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    received.push({
      type: req.headers["content-type"],
      body: Buffer.concat(parts).toString(),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const form = [
    { key: "tag", value: "first", enabled: true },
    { key: "tag", value: "skip", enabled: false },
    { key: "tag", value: "last", enabled: true },
  ];
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          method: "POST",
          url,
          bodyType: "raw",
          body: "stale",
          beforeScript: `pm.request.body.update({mode:'urlencoded',urlencoded:${JSON.stringify(form.map(({ enabled, ...row }) => ({ ...row, disabled: !enabled })))}}); pm.request.body.urlencoded.one('tag').value='last-live'; pm.request.body.urlencoded.add({key:'中文',value:'空 格&=+'}); pm.request.body.urlencoded.add({key:'__proto__',value:'literal'});`,
        },
      },
      {
        request: {
          method: "POST",
          url,
          bodyType: "form-data",
          form: [
            {
              key: "upload",
              type: "file",
              filename: "selected.txt",
              value: "c2FmZQ==",
              enabled: true,
            },
            ...form,
          ],
          beforeScript: `pm.request.body.formdata.add({key:'note',value:'first'}); pm.request.body.formdata.upsert({key:'note',value:'changed'}); pm.expect(() => pm.request.body.formdata.add({key:'file',type:'file',src:'/etc/passwd'})).to.throw();`,
        },
      },
    ],
  });
  const result = await runPlan(plan, {}, executeRequest);
  assert.equal(result.status, "passed", JSON.stringify(result.results));
  assert.equal(received.length, 2);
  assert.match(received[0].type, /application\/x-www-form-urlencoded/);
  const parsed = new URLSearchParams(received[0].body);
  assert.deepEqual(parsed.getAll("tag"), ["first", "last-live"]);
  assert.equal(parsed.get("中文"), "空 格&=+");
  assert.equal(parsed.get("__proto__"), "literal");
  assert.match(received[1].type, /multipart\/form-data; boundary=/);
  const boundary = received[1].type.split("boundary=")[1];
  const fields = received[1].body
    .split("--" + boundary)
    .filter((p) => p.includes("Content-Disposition"))
    .map((p) => {
      const split = p.indexOf("\r\n\r\n");
      const head = p.slice(0, split);
      const body = p.slice(split + 4, -2);
      return {
        name: /name="([^"]+)"/.exec(head)[1],
        filename: /filename="([^"]+)"/.exec(head)?.[1],
        body,
      };
    });
  assert.deepEqual(
    fields.filter((x) => x.name === "tag").map((x) => x.body),
    ["first", "last"],
  );
  assert.deepEqual(
    fields.find((x) => x.name === "upload"),
    { name: "upload", filename: "selected.txt", body: "safe" },
  );
  assert.equal(fields.find((x) => x.name === "note").body, "changed");
  assert.equal(
    fields.some((x) => x.name === "file"),
    false,
  );
});

test("live form entries retain identity through upsert, reject stale writes and validate metadata atomically", async () => {
  const out = await runScript(
    `
    pm.request.body.update({mode:'formdata',formdata:[{key:'x',value:'one'}]});
    const list = pm.request.body.formdata, row = list.one('x');
    list.upsert({key:'x',value:'two'}); pm.expect(row.value).to.equal('two');
    row.disabled = true; row.description = 'kept';
    pm.expect(list.toObject(true)).to.deep.equal({});
    pm.expect(() => { row.type = 'file'; }).to.throw();
    pm.expect(() => Object.defineProperty(row,'value',{value:'bad'})).to.throw();
    const snapshot = row.toJSON(); snapshot.value = 'detached'; pm.expect(row.value).to.equal('two');
    list.remove('x'); pm.expect(row.value).to.equal('two');
    pm.expect(() => { row.value = 'stale'; }).to.throw();
    pm.expect(list.count()).to.equal(0);
    list.add({key:'new',value:'real'}); const old = list.one('new');
    pm.request.body.update({mode:'formdata',formdata:[{key:'new',value:'replacement'}]});
    pm.expect(() => old.update({value:'stale'})).to.throw();
    pm.expect(pm.request.body.formdata.get('new')).to.equal('replacement');
  `,
    { request: {} },
  );
  assert.equal(out.request.form[0].value, "replacement");
});

test("form updates reject hidden unknown fields without partial changes", async () => {
  for (const mode of ["urlencoded", "formdata"]) {
    const result = await runScript(
      `
      const body=pm.request.body;
      body.update({mode:'${mode}',${mode}:[{key:'keep',value:'yes'}]});
      const form=body.${mode}, entry=form.one('keep');
      const unknowns=[{[Symbol('hidden')]:'x'},Object.defineProperty({},'hidden',{value:'x'})];
      for(const hidden of unknowns) {
        const item=Object.defineProperties({key:'bad',value:'changed'},Object.getOwnPropertyDescriptors(hidden));
        pm.expect(()=>form.add(item)).to.throw();
        item.key='keep';pm.expect(()=>form.upsert(item)).to.throw();
        const patch=Object.defineProperties({value:'changed'},Object.getOwnPropertyDescriptors(hidden));
        pm.expect(()=>entry.update(patch)).to.throw();
        const replacement=Object.defineProperties({mode:'${mode}',${mode}:[{key:'new',value:'new'}]},Object.getOwnPropertyDescriptors(hidden));
        pm.expect(()=>body.update(replacement)).to.throw();
      }
      pm.test('unchanged',()=>pm.expect(form.toObject()).to.deep.equal({keep:'yes'}));
      pm.test('identity',()=>pm.expect(form.one('keep')).to.equal(entry));
      entry.update(Object.defineProperty({},'value',{value:'known hidden value'}));
      pm.test('known field',()=>pm.expect(entry.value).to.equal('known hidden value'));
    `,
      { request: {} },
    );
    assert.ok(
      result.tests.every((x) => x.passed),
      JSON.stringify(result.tests),
    );
    assert.equal(result.request.form.length, 1);
    assert.equal(result.request.form[0].value, "known hidden value");
  }
});

test("form collection iterators keep live entries, context, snapshots and mode invalidation", async () => {
  for (const mode of ["urlencoded", "formdata"]) {
    const result = await runScript(
      `
      const body=pm.request.body;
      body.update({mode:'${mode}',${mode}:[{key:'tag',value:'one'},{key:'tag',value:'two',disabled:true}]});
      const form=body.${mode},ctx={seen:0,value:'changed'};
      form.each(function(e){this.seen++;return false;},ctx);
      form.each(function(e){pm.expect(this).to.equal(body);return false;});
      form.find(e=>!e.disabled).value=ctx.value;
      const selected=form.filter(function(e){return e.disabled===this.disabled;},{disabled:true});
      pm.test('selection',()=>{pm.expect(selected[0]).to.equal(form.idx(1));pm.expect(ctx.seen).to.equal(1);});
      const mapped=form.map(function(e,i){pm.expect(this).to.equal(form);if(i===0)form.add({key:'later',value:'three'});return e.value;});
      pm.test('snapshot',()=>pm.expect(mapped).to.deep.equal(['changed','two']));
      pm.test('reduction',()=>pm.expect(form.reduce(function(n,e){pm.expect(this).to.equal(form);return n+1;},0)).to.equal(3));
      for(const method of ['each','map','filter','find','reduce'])pm.expect(()=>form[method]('key')).to.throw();
      body.update({mode:'raw',raw:'replacement'});
      for(const method of ['each','map','filter','find','reduce'])pm.expect(()=>form[method](()=>true,0)).to.throw();
    `,
      { request: {} },
    );
    assert.ok(
      result.tests.every((x) => x.passed),
      JSON.stringify(result.tests),
    );
    assert.equal(result.request.body, "replacement");
  }
});
