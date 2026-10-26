import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import { executeRequest } from "../src/runtime.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { normalizeNativeTaskRequest } from "../src/script-database-tasks.mjs";
import {
  compilePickVarsOperations,
  normalizePickVarsData,
  pickVarsInstallerSource,
} from "../src/native-response-extraction.mjs";
import {
  captureResponseHeaderEvidence,
  readResponseHeaderEvidence,
  NATIVE_HEADER_PAIR_LIMIT,
} from "../src/response-header-evidence.mjs";
const row = (name, expression, type = "envVars") => ({
  name,
  expression,
  type,
});
const data = (variables) => ({ source: "responseHeader", variables });
const pick = (variables, enabled = 1) => ({
  type: "pickVars",
  enabled,
  data: data(variables),
});
const script = (code) => ({ type: "customScript", enabled: 1, data: code });

async function fixture(t) {
  const server = http.createServer((_req, res) => {
    res.setHeader("x-token", "wire-token");
    res.setHeader("x-empty", "");
    res.setHeader("x-comma", "one, literal");
    res.end("<html>not JSON</html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return executeRequest({ url: `http://127.0.0.1:${server.address().port}/` });
}
const phase = (response, tasks) =>
  runNativeTaskPhase(tasks, {
    request: {},
    response,
    variables: { token: "old-token" },
  });

test("native Header validates only enabled literal fields and keeps disabled closed data inert", () => {
  const normalized = normalizePickVarsData(data([row("token", " X-ToKeN ")]));
  assert.deepEqual(normalized, data([row("token", " X-ToKeN ")]));
  assert.equal(
    compilePickVarsOperations([normalized])[0].variables[0].header,
    "x-token",
  );
  for (const expression of [
    "",
    " ",
    "x token",
    "x\r\nInjected:y",
    "{{token}}",
    "x[0]",
    "x:token",
  ])
    assert.throws(
      () => normalizePickVarsData(data([row("token", expression)])),
      /字面/,
    );
  // A token-shaped '$.token' is a literal header name, never a JSON selector.
  assert.equal(
    compilePickVarsOperations([data([row("token", "$.token")])])[0].variables[0]
      .header,
    "$.token",
  );
  const inert = data([row("", "{{invalid}}")]);
  assert.deepEqual(normalizePickVarsData(inert, { enabled: false }), inert);
  assert.throws(() =>
    normalizePickVarsData({ ...inert, surprise: true }, { enabled: false }),
  );
  assert.throws(() =>
    normalizePickVarsData(data([{ ...row("x", "x"), enabled: 0 }]), {
      enabled: false,
    }),
  );
  assert.throws(
    () =>
      normalizeNativeTaskRequest({
        inheritSharedScripts: false,
        nativeTasks: {
          version: 1,
          before: [pick([row("token", "x-token")])],
          after: [],
        },
      }),
    /后置/,
  );
  assert.doesNotThrow(() =>
    normalizeNativeTaskRequest({
      inheritSharedScripts: false,
      nativeTasks: {
        version: 1,
        before: [pick([row("", "{{invalid}}")], 0)],
        after: [],
      },
    }),
  );
  assert.throws(() =>
    normalizePickVarsData(
      data(Array.from({ length: 101 }, () => row("x", "x"))),
    ),
  );
});

test("native Header required fields cannot be inherited or invoke prototype getters", () => {
  let calls = 0;
  for (const key of ["source", "variables", "name", "expression", "type"]) {
    const input = data([row("token", "x-token")]);
    delete (["source", "variables"].includes(key) ? input : input.variables[0])[
      key
    ];
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      get() {
        calls++;
        return key === "source" ? "responseHeader" : "fake";
      },
    });
    try {
      assert.throws(() => normalizePickVarsData(input), /自有/);
    } finally {
      delete Object.prototype[key];
    }
  }
  assert.equal(calls, 0);
});

test("native Header count evidence is frozen, complete, bounded, no values and identity-only", () => {
  const response = captureResponseHeaderEvidence(
    {},
    [
      "X-Token",
      "secret1",
      "x-token",
      "secret2",
      "__proto__",
      "safe",
      "constructor",
      "safe",
    ],
    "1.1",
  );
  const evidence = readResponseHeaderEvidence(response);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.counts["x-token"], 2);
  assert.equal(evidence.counts.__proto__, 1);
  assert.equal(evidence.counts.constructor, 1);
  assert.equal(Object.getPrototypeOf(evidence.counts), null);
  assert(Object.isFrozen(evidence));
  assert(Object.isFrozen(evidence.counts));
  assert(!JSON.stringify(evidence).includes("secret"));
  assert.equal(
    readResponseHeaderEvidence({ ...response, headerEvidence: evidence })
      .complete,
    false,
  );
  assert.equal(
    readResponseHeaderEvidence(structuredClone(response)).complete,
    false,
  );
  assert.throws(() => (evidence.counts["x-token"] = 1));
  const raw = Array.from({ length: NATIVE_HEADER_PAIR_LIMIT }, (_, i) => [
    `x-${i}`,
    "v",
  ]).flat();
  assert.equal(
    readResponseHeaderEvidence(captureResponseHeaderEvidence({}, raw, "1.1"))
      .complete,
    true,
  );
  let calls = 0;
  const accessor = ["x", "v"];
  Object.defineProperty(accessor, 1, {
    enumerable: true,
    get() {
      calls++;
      return "v";
    },
  });
  for (const invalid of [
    undefined,
    {},
    ["x"],
    ["x", 0],
    ["bad name", "v"],
    accessor,
    raw.concat("x-extra", "v"),
    Array(2),
  ])
    assert.equal(
      readResponseHeaderEvidence(
        captureResponseHeaderEvidence({}, invalid, "1.1"),
      ).complete,
      false,
    );
  assert.equal(calls, 0);
  assert.equal(
    readResponseHeaderEvidence(
      captureResponseHeaderEvidence(
        {},
        [":status", "200", "x-token", "v"],
        "2.0",
      ),
    ).counts["x-token"],
    1,
  );
  assert.equal(
    readResponseHeaderEvidence(
      captureResponseHeaderEvidence({}, [":status", "200"], "1.1"),
    ).complete,
    false,
  );
});

test("native Header validates all rows before writes and never invokes a selected getter or body reader", () => {
  const headers = { "x-token": "new-token" },
    assignments = [];
  let getters = 0,
    bodyReads = 0;
  Object.defineProperty(headers, "x-bad", {
    enumerable: true,
    get() {
      getters++;
      return "bad";
    },
  });
  const install = vm.runInNewContext(`(${pickVarsInstallerSource})`);
  const state = install(
    JSON.stringify(
      compilePickVarsOperations([
        data([row("token", "x-token"), row("bad", "x-bad")]),
      ]),
    ),
    () => {
      bodyReads++;
      throw Error("body getter");
    },
    headers,
    JSON.stringify({ complete: true, counts: { "x-token": 1, "x-bad": 1 } }),
    (...entry) => assignments.push(entry),
    () => {},
    () => {},
  );
  assert.throws(() => state.run(0), /字符串/);
  assert.deepEqual(assignments, []);
  assert.equal(getters, 0);
  assert.equal(bodyReads, 0);
  assert.throws(() => state.assertComplete(), /未完成/);
});

test("native Header captures current map but not replaced public readers, map, facade or intrinsics", async (t) => {
  const response = await fixture(t),
    original = structuredClone(response);
  const result = await phase(response, [
    script(`const initial=response.headers;initial['x-token']='current-token';
      pm.response.headers.get=()=>{throw Error('public get');};
      pm.response.headers.has=()=>{throw Error('public has');};
      pm.response.headers.all=()=>{throw Error('public all');};
      response.headers={'x-token':'replaced-map'};pm.response.headers={'get':()=> 'replaced-facade'};
      Object.getOwnPropertyDescriptor=()=>{throw Error('descriptor');};
      String.prototype.toLowerCase=()=>{throw Error('lowercase');};
      String.prototype.charCodeAt=()=>{throw Error('charCodeAt');};
      JSON.parse=()=>{throw Error('parse');};
      Object.defineProperty(Object.prototype,'segments',{get(){throw Error('inherited segments');},configurable:true});`),
    pick([
      row("token", " X-ToKeN "),
      row("empty", "x-empty"),
      row("comma", "x-comma"),
    ]),
    script(`delete Object.prototype.segments;`),
  ]);
  assert.equal(result.scopes.environment.token, "current-token");
  assert.equal(result.scopes.environment.empty, "");
  assert.equal(result.scopes.environment.comma, "one, literal");
  assert.deepEqual(response, original);
});

test("native Header rejects absent/forged/replayed transport proof and new header names", async (t) => {
  const response = await fixture(t);
  for (const fake of [
    structuredClone(response),
    {
      status: 200,
      body: "{}",
      headers: { "x-token": "fake" },
      rawHeaders: ["x-token", "fake"],
      headerEvidence: { complete: true, counts: { "x-token": 1 } },
    },
  ])
    await assert.rejects(
      phase(fake, [pick([row("token", "x-token")])]),
      /传输证据/,
    );
  await assert.rejects(
    phase(response, [
      script("response.headers['x-new']='forged';"),
      pick([row("token", "x-new")]),
    ]),
    /传输证据/,
  );
});

test("native Header bounds current primitive strings and rejects getter, deletion, array and object values", async (t) => {
  const response = await fixture(t);
  for (const mutation of [
    "delete response.headers['x-token'];",
    "response.headers['x-token']=['fake'];",
    "response.headers['x-token']={toString(){return 'fake';}};",
    "Object.defineProperty(response.headers,'x-token',{get(){throw Error('getter was invoked');}});",
    "Object.defineProperty(response.headers,'x-token',{get(){throw Error('getter was invoked');}});Object.prototype.value='forged';Object.hasOwn=()=>true;",
    "response.headers['x-token']='x'.repeat(65537);",
    "response.headers['x-token']='雪'.repeat(21846);",
    "response.headers['x-token']='\\ud800';",
  ])
    await assert.rejects(
      phase(response, [script(mutation), pick([row("token", "x-token")])]),
      /字符串|64KiB|Unicode/,
    );
  const limit = await phase(response, [
    script("response.headers['x-token']='雪'.repeat(21845)+'x';"),
    pick([row("token", "x-token")]),
  ]);
  assert.equal(Buffer.byteLength(limit.scopes.environment.token), 65536);
});

test("native Header completion cannot be bypassed by return, cross-task catch or replacing global proof", async (t) => {
  const response = await fixture(t);
  for (const tasks of [
    [script("return;"), pick([row("token", "x-token")])],
    [script("try {"), pick([row("token", "missing")]), script("} catch {}")],
    [
      script(
        "globalThis.__nativePickVarsDataJSON=JSON.stringify({operations:[],evidence:{complete:true,counts:{missing:1}}});response.headerEvidence={complete:true,counts:{missing:1}};response.headers.missing='forged';",
      ),
      pick([row("token", "missing")]),
    ],
  ])
    await assert.rejects(phase(response, tasks), /未完成|传输证据/);
  const completed = await phase(response, [
    pick([row("token", "x-token")]),
    script("return;"),
  ]);
  assert.equal(completed.scopes.environment.token, "wire-token");
});

test("native Header proof overflow does not truncate ordinary visible headers or reject JSON extraction", async (t) => {
  const server = http.createServer((_req, res) => {
    for (let at = 0; at < 300; at++) res.setHeader("x-" + at, "v");
    res.setHeader("x-tail", "visible");
    res.end('{"token":"json-token"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const response = await executeRequest({
    url: `http://127.0.0.1:${server.address().port}/`,
  });
  assert.equal(response.headers["x-tail"], "visible");
  assert(Object.keys(response.headers).length > 300);
  assert.equal(readResponseHeaderEvidence(response).complete, false);
  const result = await phase(response, [
    {
      type: "pickVars",
      enabled: 1,
      data: { source: "responseJson", variables: [row("token", "$.token")] },
    },
  ]);
  assert.equal(result.scopes.environment.token, "json-token");
  await assert.rejects(
    phase(response, [pick([row("token", "x-tail")])]),
    /传输证据/,
  );
});
