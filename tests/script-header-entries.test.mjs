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
            "pm.request.headers.one('X-ONE').value='wire';pm.request.headers.idx(2).disabled=false;",
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
