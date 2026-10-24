import { validateResponseMutation } from "../src/script-response-mutation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { runScript, runScriptSequence } from "../src/scripts.mjs";

const wire = () => ({
  status: 500,
  statusText: "Server Error",
  body: '{"wire":true}',
  headers: { "content-type": "application/json" },
  duration: 7,
  size: 13,
});

test("response mutations provide a derived view without modifying the input network response", async () => {
  for (const scriptDialect of ["legacy", "apipost8"]) {
    const response = wire(),
      before = structuredClone(response);
    const out = await runScript(
      `
      pm.response.setBody({ value: 0 }); apt.response.setCode(201);
      pm.test('changed and original', () => {
        pm.expect(pm.response.json()).to.deep.equal({ value: 0 });
        pm.expect(pm.response.code).to.equal(201);
        pm.expect(apt.response.code).to.equal(201);
        pm.expect(pm.response.originalText()).to.equal('{"wire":true}');
        pm.expect(apt.response.originalJson()).to.deep.equal({ wire: true });
        pm.expect(pm.response.originalCode()).to.equal(500);
        pm.expect(response.raw.status).to.equal(500);
        pm.expect(response.raw.responseText).to.equal('{"wire":true}');
        pm.expect(pm.response.headers.get('content-type')).to.equal('application/json');
      });
      apt.setVar('view', ${scriptDialect === "legacy" ? "apt.response.json" : "apt.response.json()"});
    `,
      { response, request: { scriptDialect } },
    );
    assert.deepEqual(response, before);
    assert.deepEqual(out.responseOverride, {
      body: '{"value":0}',
      status: 201,
    });
    assert.deepEqual(out.variables.view, { value: 0 });
    assert(
      out.tests.every((x) => x.passed),
      JSON.stringify(out.tests),
    );
  }
});

test("original readers capture the value before the most recent matching mutation and return copies", async () => {
  const out = await runScript(
    `
    pm.response.setBody({ x: 1 }); pm.response.setBody(false);
    pm.response.setCode(201); pm.response.setCode(202);
    pm.test('previous values', () => {
      const original = pm.response.originalJson(); original.x = 99;
      pm.expect(pm.response.originalJson()).to.deep.equal({ x: 1 });
      pm.expect(pm.response.originalText()).to.equal('{"x":1}');
      pm.expect(pm.response.originalCode()).to.equal(201);
      pm.expect(pm.response.json()).to.equal(false);
    });
    pm.response.setBody('plain'); pm.response.setBody('');
    pm.test('non JSON prior body', () => pm.expect(pm.response.originalJson()).to.equal(null));
  `,
    { response: wire() },
  );
  assert.deepEqual(out.responseOverride, { body: "", status: 202 });
  assert(
    out.tests.every((x) => x.passed),
    JSON.stringify(out.tests),
  );
});

test("invalid response mutations fail atomically and cannot be used before a response exists", async () => {
  for (const call of ['pm.response.setBody("x")', "pm.response.setCode(201)"])
    await assert.rejects(runScript(call, {}), /后置|响应/);
  const out = await runScript(
    `
    pm.response.setBody('valid'); pm.response.setCode(201);
    const invalid = [undefined, () => {}, 1n, '\\ud800', '你'.repeat(21846)];
    for (const value of invalid) pm.expect(() => pm.response.setBody(value)).to.throw();
    const cycle = {}; cycle.self = cycle;
    pm.expect(() => pm.response.setBody(cycle)).to.throw();
    for (const value of [0, 600, 200.5, '200', null, NaN]) pm.expect(() => pm.response.setCode(value)).to.throw();
    pm.test('unchanged', () => { pm.expect(pm.response.text()).to.equal('valid'); pm.expect(pm.response.code).to.equal(201); pm.expect(response.raw.status).to.equal(500); pm.expect(response.raw.responseText).to.equal('{\"wire\":true}'); });
  `,
    { response: wire() },
  );
  assert.deepEqual(out.responseOverride, { body: "valid", status: 201 });
  assert(
    out.tests.every((x) => x.passed),
    JSON.stringify(out.tests),
  );
  const boundary = await runScript(`pm.response.setBody('😀'.repeat(16384));`, {
    response: wire(),
  });
  assert.equal(Buffer.byteLength(boundary.responseOverride.body), 65536);
  await assert.rejects(
    runScript('pm.response.setBody("x")', {
      response: { ...wire(), body: "x".repeat(524289) },
    }),
    /512KiB/,
  );
});

test("ordered post-script scopes retain mutations and prior-value readers within unchanged phase budgets", async () => {
  const response = wire();
  const out = await runScriptSequence(
    [
      {
        name: "project",
        code: "pm.response.setBody({first:true}); pm.response.setCode(201);",
      },
      {
        name: "folder",
        code: `pm.test('prior scope', () => { pm.expect(pm.response.json()).to.deep.equal({first:true}); pm.expect(pm.response.originalText()).to.equal('{"wire":true}'); pm.expect(pm.response.originalCode()).to.equal(500); }); pm.response.setBody(null);`,
      },
      {
        name: "request",
        code: `pm.test('null and prior body', () => { pm.expect(pm.response.json()).to.equal(null); pm.expect(pm.response.originalJson()).to.deep.equal({first:true}); pm.expect(pm.response.code).to.equal(201); pm.expect(response.raw.status).to.equal(500); pm.expect(response.raw.responseText).to.equal('{\"wire\":true}'); });`,
      },
    ],
    { response },
  );
  assert.deepEqual(response, wire());
  assert.deepEqual(out.responseOverride, { body: "null", status: 201 });
  assert(
    out.tests.every((x) => x.passed),
    JSON.stringify(out.tests),
  );
  assert(out.activityMs <= 250);
});

test("thrown scripts do not return a partially committed response view", async () => {
  await assert.rejects(
    runScript('pm.response.setBody("changed"); throw Error("stop");', {
      response: wire(),
    }),
    /stop/,
  );
  const out = await runScript("", { response: wire() });
  assert.equal(out.responseOverride, null);
});

test("host-side response validation rejects forged fields and preserves existing byte budgets", async () => {
  const { validateResponseMutation } = await import(
    "../src/script-response-mutation.mjs"
  );
  for (const value of [
    { headers: {} },
    { body: 0 },
    { status: 600 },
    [],
    JSON.parse('{"__proto__":{}}'),
  ])
    assert.throws(() => validateResponseMutation(value), /响应/);
  assert.throws(() => validateResponseMutation({ body: "x" }, false), /后置/);
  assert.throws(
    () => validateResponseMutation({ body: "😀".repeat(16385) }),
    /64KiB/,
  );
  assert.throws(
    () => validateResponseMutation({ body: "x".repeat(524289) }, true, true),
    /512KiB/,
  );
  assert.deepEqual(validateResponseMutation({ body: "", status: 599 }), {
    body: "",
    status: 599,
  });
});

test("real HTTP debug and persisted history keep failure status and raw body separate from script output", async (t) => {
  const http = await import("node:http");
  const { createApp } = await import("../src/server.mjs");
  const { normalizeRequest, runPlan, snapshotPlan } = await import(
    "../src/core.mjs"
  );
  const { executeRequest } = await import("../src/runtime.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "response-mutation-"));
  const fixture = http.createServer((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"wire":true}');
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    fixture.closeAllConnections();
    app.server.closeAllConnections();
    await Promise.all([
      new Promise((r) => fixture.close(r)),
      new Promise((r) => app.server.close(r)),
    ]);
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const project = await app.store.create("Response views");
  const request = normalizeRequest({
    url: `http://127.0.0.1:${fixture.address().port}`,
    extract: [{ name: "wireEvidence", path: "$.wire" }],
    afterScript:
      'pm.response.setBody({changed:0}); pm.response.setCode(200); pm.test("derived", () => pm.expect(pm.response.json().changed).to.equal(0));',
  });
  const reply = await fetch(`${app.url}/api/projects/${project.id}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-token": app.token },
    body: JSON.stringify({ request }),
  });
  assert.equal(reply.status, 200);
  const value = await reply.json();
  assert.equal(value.status, 500);
  assert.equal(value.body, '{"wire":true}');
  assert.equal(value.outcome, "failed");
  assert.equal(value.extracted.wireEvidence, true);
  assert.deepEqual(value.scriptResponse, {
    body: '{"changed":0}',
    status: 200,
  });
  assert(value.assertions.every((x) => x.passed));
  const [history] = (await app.store.get(project.id)).history;
  assert.equal(history.response.status, 500);
  assert.equal(history.response.body, '{"wire":true}');
  assert.equal(history.status, "failed");
  assert.deepEqual(history.scriptResponse, value.scriptResponse);
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          ...request,
          assertions: [{ target: "status", op: "eq", value: 200 }],
        },
      },
    ],
  });
  const result = await runPlan(plan, {}, executeRequest);
  assert.equal(result.status, "failed");
  assert(
    result.results[0].assertions.some(
      (x) => x.target === "status" && !x.passed,
    ),
  );
  assert.equal(result.results[0].response.status, 500);
  assert.deepEqual(result.results[0].scriptResponse, value.scriptResponse);
});

test("large ASCII originals validate within the unchanged VM budget and exact UTF-8 boundaries remain strict", async () => {
  const body = "x".repeat(512 * 1024);
  const out = await runScript('pm.response.setBody("small");', {
    response: { ...wire(), body },
  });
  assert.equal(out.responseOriginals.body, body);
  assert.equal(out.responseOverride.body, "small");
  assert(out.activityMs <= 250);
  for (const [limit, originals] of [
    [65536, false],
    [524288, true],
  ]) {
    const unicode = "中".repeat(Math.floor(limit / 3)) + "x".repeat(limit % 3);
    assert.equal(
      validateResponseMutation({ body: unicode }, true, originals).body,
      unicode,
    );
    assert.throws(
      () => validateResponseMutation({ body: unicode + "x" }, true, originals),
      /KiB/,
    );
    assert.throws(
      () =>
        validateResponseMutation(
          { body: "x".repeat(limit + 1) },
          true,
          originals,
        ),
      /KiB/,
    );
    assert.throws(
      () =>
        validateResponseMutation(
          { body: "x".repeat(100) + String.fromCharCode(0xd800) },
          true,
          originals,
        ),
      /Unicode/,
    );
  }
});
