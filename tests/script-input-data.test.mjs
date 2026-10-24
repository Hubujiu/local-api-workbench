import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { executeRequest } from "../src/runtime.mjs";
import { runPlan, snapshotPlan } from "../src/core.mjs";
import { runScript, runScriptSequence } from "../src/scripts.mjs";

test("script input preserves JSON __proto__ as an own data property without changing prototypes", async () => {
  const payload = JSON.parse(
    '{"__proto__":{"marker":"data-only"},"constructor":"ordinary","prototype":null}',
  );
  const result = await runScript(
    `
  const value=pm.variables.get('payload');
  pm.test('own property',()=>pm.expect(Object.hasOwn(value,'__proto__')).to.equal(true));
  pm.test('ordinary prototype',()=>pm.expect(Object.getPrototypeOf(value)===Object.prototype).to.equal(true));
  pm.test('no inherited marker',()=>pm.expect(value.marker).to.equal(undefined));
  pm.test('data value',()=>pm.expect(value['__proto__'].marker).to.equal('data-only'));
  pm.test('no global mutation',()=>pm.expect(({}).marker).to.equal(undefined));
 `,
    { variables: { payload } },
  );
  assert(
    result.tests.every((t) => t.passed),
    JSON.stringify(result.tests),
  );
  assert.deepEqual(result.variables.payload, payload);
  assert.equal(Object.prototype.marker, undefined);
});

test("script response header maps preserve prototype-sensitive own names", async () => {
  const headers = JSON.parse(
    '{"__proto__":"literal-header","constructor":"constructor-header","x-value":"regular"}',
  );
  const result = await runScript(
    `
  pm.test('header value',()=>pm.expect(pm.response.headers.get('__proto__')).to.equal('literal-header'));
  pm.test('apt header value',()=>pm.expect(apt.response.headers['__proto__']).to.equal('literal-header'));
  pm.test('constructor value',()=>pm.expect(pm.response.headers.get('constructor')).to.equal('constructor-header'));
  pm.test('missing inherited name',()=>pm.expect(pm.response.headers.get('toString')).to.equal(undefined));
  let calls=0; const key={toString(){return ++calls===1?'constructor':'toString';}};
  pm.test('one coercion value',()=>pm.expect(pm.response.headers.get(key)).to.equal('constructor-header'));
  pm.test('one coercion count',()=>pm.expect(calls).to.equal(1));
 `,
    {
      variables: {},
      response: {
        status: 200,
        statusText: "OK",
        headers,
        body: "{}",
        duration: 1,
        size: 2,
      },
    },
  );
  assert(
    result.tests.every((t) => t.passed),
    JSON.stringify(result.tests),
  );
});

test("script input strings remain inert JSON across staged serialization", async () => {
  const text =
    'quote"; throw Error("must not execute"); //\n emoji😀 \u2028 \ud800';
  const payload = JSON.parse('{"__proto__":7,"nested":{"__proto__":null}}');
  const result = await runScriptSequence(
    [
      {
        name: "first",
        code: 'pm.variables.set("copy",pm.variables.get("text"));',
      },
      {
        name: "second",
        code: 'pm.test("no transport global",()=>pm.expect(typeof globalThis.__localapiInputJSON).to.equal("undefined"));',
      },
    ],
    { variables: { text, payload } },
  );
  assert(
    result.tests.every((t) => t.passed),
    JSON.stringify(result.tests),
  );
  assert.equal(result.localVariables.copy, text);
  assert.deepEqual(result.variables.payload, payload);
});

test("real HTTP response and script subrequest header readers never substitute inherited properties", async (t) => {
  const server = http.createServer((_req, res) => {
    res.setHeader("constructor", "wire-data");
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const script = `pm.test('wire',()=>pm.expect(pm.response.headers.get('constructor')).to.equal('wire-data'));pm.test('absent',()=>pm.expect(pm.response.headers.get('__proto__')).to.equal(undefined));`;
  const run = await runPlan(
    snapshotPlan({
      steps: [{ request: { method: "GET", url, afterScript: script } }],
    }),
    {},
    executeRequest,
  );
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  const sub = await runScript(
    `const response=await pm.sendRequest(${JSON.stringify(url)});pm.test('wire',()=>pm.expect(response.headers.get('constructor')).to.equal('wire-data'));pm.test('absent',()=>pm.expect(response.headers.get('__proto__')).to.equal(undefined));`,
    { variables: {}, allowNetwork: true },
  );
  assert(
    sub.tests.every((t) => t.passed),
    JSON.stringify(sub.tests),
  );
});

test("JSON extraction survives the next script stage and reaches a real subsequent HTTP request", async (t) => {
  const payload = JSON.parse(
    '{"__proto__":{"marker":"payload-data"},"value":1}',
  );
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      req.url === "/source"
        ? JSON.stringify(payload)
        : JSON.stringify({ marker: req.headers["x-marker"] }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = await runPlan(
    snapshotPlan({
      steps: [
        {
          request: {
            method: "GET",
            url: base + "/source",
            extract: [{ name: "payload", path: "$" }],
          },
        },
        {
          request: {
            method: "GET",
            url: base + "/echo",
            beforeScript: `const data=apt.getVar('payload');pm.test('own input data',()=>pm.expect(Object.hasOwn(data,'__proto__')).to.equal(true));pm.test('ordinary input prototype',()=>pm.expect(Object.getPrototypeOf(data)===Object.prototype).to.equal(true));apt.setRequestHeader('X-Marker',data['__proto__'].marker);`,
            afterScript: `pm.test('reached echo',()=>pm.expect(pm.response.json().marker).to.equal('payload-data'));`,
          },
        },
      ],
    }),
    {},
    executeRequest,
  );
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.deepEqual(run.variables.payload, payload);
});
