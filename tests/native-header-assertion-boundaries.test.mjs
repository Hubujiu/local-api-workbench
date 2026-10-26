import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import http2 from "node:http2";
import { executeRequest } from "../src/runtime.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { normalizeNativeTaskRequest } from "../src/script-database-tasks.mjs";
import {
  compileNativeAssertions,
  normalizeNativeAssertionData,
  nativeAssertionsInstallerSource,
} from "../src/native-response-assertions.mjs";
import { readResponseHeaderEvidence } from "../src/response-header-evidence.mjs";
const data = (path, compareValue, compareType = "eq") => ({
  type: "responseHeader",
  expression: { path, compareType, compareValue },
});
const assertion = (path, expected, comparison = "eq") => ({
  type: "assert",
  enabled: 1,
  name: path || "empty path",
  data: data(path, expected, comparison),
});
const script = (code) => ({ type: "customScript", enabled: 1, data: code });
const pick = (expression) => ({
  type: "pickVars",
  enabled: 1,
  data: {
    source: "responseHeader",
    variables: [{ name: "picked", type: "envVars", expression }],
  },
});
const phase = (response, tasks, options) =>
  runNativeTaskPhase(tasks, { request: {}, response }, options);
async function fixture(t, version = "1.1", handler) {
  const server = version === "2" ? http2.createServer() : http.createServer();
  const sessions = new Set();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  server.on(
    "request",
    handler ||
      ((_req, res) => {
        res.setHeader("x-token", "wire-token");
        res.setHeader("x-empty", "");
        res.setHeader("x-comma", "one, literal");
        res.setHeader("x-undefined", "undefined");
        res.setHeader("$.literal", "literal-not-path");
        res.end("<html>not JSON</html>");
      }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const session of sessions) session.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return executeRequest({
    url: `http://127.0.0.1:${server.address().port}/`,
    httpVersion: version,
  });
}

test("native Header assertion literal paths are raw casefold, not pick normalization or JSON paths", () => {
  for (const path of [
    " X-ToKeN ",
    "",
    "$.literal",
    "$[*]",
    "x\r\nnot-a-field",
  ]) {
    const normalized = normalizeNativeAssertionData(data(path, "undefined"));
    assert.equal(normalized.expression.path, path);
    assert.equal(
      compileNativeAssertions([{ name: "test", data: normalized }])[0].header,
      path.toLowerCase(),
    );
  }
  for (const invalid of [
    data("{{token}}", "value"),
    data("x-token", "{{token}}"),
    data("x", "v", "regex"),
    data("x", 1),
    data("x".repeat(1001), "v"),
    data("x", "v".repeat(65536)),
    data("\ud800", "v"),
    { ...data("x", "v"), type: "responseXml" },
  ])
    assert.throws(() => normalizeNativeAssertionData(invalid));
  const inert = {
    type: "responseHeader",
    expression: { path: "{{inert}}", compareValue: "{{inert}}" },
  };
  assert.deepEqual(
    normalizeNativeAssertionData(inert, { enabled: false }),
    inert,
  );
  assert.throws(() => normalizeNativeAssertionData(inert));
  assert.throws(
    () =>
      normalizeNativeTaskRequest({
        inheritSharedScripts: false,
        nativeTasks: { version: 1, before: [assertion("x", "v")], after: [] },
      }),
    /后置/,
  );
  assert.throws(() =>
    compileNativeAssertions(
      Array.from({ length: 17 }, () => ({ name: "a", data: data("x", "v") })),
    ),
  );
  assert.throws(
    () =>
      compileNativeAssertions(
        Array.from({ length: 5 }, () => ({
          name: "a",
          data: data("x", "v".repeat(60000)),
        })),
      ),
    /256KiB/,
  );
});

test("native Header assertion required fields never invoke inherited getters", () => {
  for (const key of [
    "type",
    "expression",
    "path",
    "compareValue",
    "compareType",
    "name",
    "data",
  ]) {
    let calls = 0;
    const input = { name: "test", data: data("x-token", "wire-token") };
    const target = ["name", "data"].includes(key)
      ? input
      : ["type", "expression"].includes(key)
        ? input.data
        : input.data.expression;
    delete target[key];
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      get() {
        calls++;
        throw Error("inherited getter");
      },
    });
    try {
      assert.throws(() => compileNativeAssertions([input]), /自有|字面/);
    } finally {
      delete Object.prototype[key];
    }
    assert.equal(calls, 0, key);
  }
  let calls = 0;
  Object.defineProperty(Object.prototype, "compareType", {
    configurable: true,
    get() {
      calls++;
      throw Error("inherited optional");
    },
  });
  try {
    assert.deepEqual(
      normalizeNativeAssertionData(
        { type: "responseHeader", expression: { path: "", compareValue: "" } },
        { enabled: false },
      ),
      { type: "responseHeader", expression: { path: "", compareValue: "" } },
    );
  } finally {
    delete Object.prototype.compareType;
  }
  assert.equal(calls, 0);
});

for (const version of ["1.1", "2"])
  test(`native Header assertion HTTP/${version} distinguishes trusted missing, empty, undefined, comma and deletion without changing pick`, async (t) => {
    const response = await fixture(t, version),
      original = structuredClone(response);
    const result = await phase(response, [
      assertion("X-ToKeN", "wire-token"),
      assertion(" X-ToKeN ", "undefined"),
      assertion("", "undefined"),
      assertion("x-missing", "undefined"),
      assertion("x-empty", ""),
      assertion("x-undefined", "undefined"),
      assertion("x-comma", "one, literal"),
      assertion("$.literal", "literal-not-path"),
      assertion("x-token", "other", "uneq"),
      script("response.headers['x-token']='edited';"),
      assertion("x-token", "edited"),
      script("delete response.headers['x-token'];"),
      assertion("x-token", "undefined"),
    ]);
    assert.equal(result.tests.length, 11);
    assert(result.tests.every((entry) => entry.passed));
    assert.deepEqual(response, original);
    await assert.rejects(phase(response, [pick("missing")]), /传输证据/);
    await assert.rejects(
      phase(response, [
        script("delete response.headers['x-token'];"),
        pick("x-token"),
      ]),
      /字符串/,
    );
    assert.equal(
      (await phase(response, [pick(" X-ToKeN ")])).scopes.environment.picked,
      "wire-token",
    );
  });

test("native Header installer lookup failures are outside callback and never read getters/body/code", () => {
  const install = vm.runInNewContext(`(${nativeAssertionsInstallerSource})`);
  let bodyReads = 0,
    getterReads = 0,
    registrations = 0;
  const headers = { "x-token": "wire-token" };
  Object.defineProperty(headers, "x-getter", {
    enumerable: true,
    get() {
      getterReads++;
      throw Error("getter");
    },
  });
  const tests = [],
    state = install(
      JSON.stringify(
        compileNativeAssertions([
          { name: "pass", data: data("x-token", "wire-token") },
          { name: "getter", data: data("x-getter", "bad") },
        ]),
      ),
      () => {
        bodyReads++;
        throw Error("body/code reader");
      },
      (name, callback) => {
        registrations++;
        callback();
        tests.push({ name, passed: true });
      },
      tests,
      headers,
      JSON.stringify({
        complete: true,
        counts: { "x-token": 1, "x-getter": 1 },
      }),
    );
  state.run(0);
  assert.throws(() => state.run(1), /字符串/);
  assert.throws(() => state.assertComplete(), /未完成/);
  assert.equal(bodyReads, 0);
  assert.equal(getterReads, 0);
  assert.equal(registrations, 1);
});

test("native Header assertion bypasses live throwing body/code getters and replaced facade/get/intrinsics", async (t) => {
  const response = await fixture(t),
    original = structuredClone(response);
  const result = await phase(response, [
    script(`
    const captured=response.headers, facade=pm.response; captured['x-token']='current';
    let bodyReads=0, codeReads=0;
    const bodyDescriptor=Object.getOwnPropertyDescriptor(response,'body'), codeDescriptor=Object.getOwnPropertyDescriptor(facade,'code');
    const define=Object.defineProperty;
    define(response,'body',{configurable:true,get(){bodyReads++;throw Error('body getter');}});
    define(facade,'code',{configurable:true,get(){codeReads++;throw Error('code getter');}});
    pm.response.headers.get=()=>{throw Error('public get');};
    response.headers={'x-token':'forged map'};pm.response.headers={get:()=> 'forged facade'};
    pm.test=()=>{throw Error('public pm.test');};
    Object.getOwnPropertyDescriptor=()=>{throw Error('descriptor');};Object.hasOwn=()=>true;
    String.prototype.toLowerCase=()=>{throw Error('lowercase');};String.prototype.charCodeAt=()=>{throw Error('charCode');};
    JSON.parse=()=>{throw Error('parse');};
    Object.defineProperty(Object.prototype,'segments',{configurable:true,get(){throw Error('segments');}});
  `),
    assertion("X-ToKeN", "current"),
    assertion("x-empty", ""),
    assertion("x-missing", "undefined"),
    script(`
    delete Object.prototype.segments;
    define(response,'body',bodyDescriptor);define(facade,'code',codeDescriptor);
    pm.environment.set('bodyReads',bodyReads);pm.environment.set('codeReads',codeReads);
  `),
  ]);
  assert(result.tests.every((entry) => entry.passed));
  assert.equal(result.scopes.environment.bodyReads, 0);
  assert.equal(result.scopes.environment.codeReads, 0);
  assert.deepEqual(response, original);
});

test("native Header assertion rejects absent/cloned/serialized proof and user-added map fields", async (t) => {
  const response = await fixture(t);
  for (const fake of [
    structuredClone(response),
    {
      ...response,
      headerEvidence: readResponseHeaderEvidence(response),
      rawHeaders: ["x-token", "wire-token"],
    },
  ])
    for (const path of ["x-token", "x-missing"])
      await assert.rejects(
        phase(fake, [
          assertion(path, path === "x-token" ? "wire-token" : "undefined"),
        ]),
        /传输证据/,
      );
  for (const code of [
    "response.headers['x-new']='fake';",
    "globalThis.__nativeAssertionDataJSON=JSON.stringify({operations:[],evidence:{complete:true,counts:{'x-new':1}}});response.headerEvidence={complete:true,counts:{'x-new':1}};response.headers['x-new']='fake';",
  ])
    await assert.rejects(
      phase(response, [script(code), assertion("x-new", "fake")]),
      /传输证据/,
    );
});

test("native Header assertion rejects current accessors, nonstrings, malformed Unicode and overlarge UTF8 values", async (t) => {
  const response = await fixture(t);
  for (const code of [
    "response.headers['x-token']=undefined;",
    "response.headers['x-token']=null;",
    "response.headers['x-token']=1;",
    "response.headers['x-token']=['only'];",
    "response.headers['x-token']={toString(){throw Error('coercion');}};",
    "Object.defineProperty(response.headers,'x-token',{get(){throw Error('getter invoked');}});Object.prototype.value='forged';",
    "response.headers['x-token']='x'.repeat(65537);",
    "response.headers['x-token']='雪'.repeat(21846);",
    "response.headers['x-token']='\\ud800';",
    "response.headers['x-token']='\\udc00';",
  ])
    await assert.rejects(
      phase(response, [script(code), assertion("x-token", "ignored")]),
      /字符串|64KiB|Unicode/,
    );
  const result = await phase(response, [
    script("response.headers['x-token']='雪'.repeat(21845)+'x';"),
    assertion("x-token", "short", "uneq"),
  ]);
  assert.equal(result.tests[0].passed, true);
});

for (const version of ["1.1", "2"])
  test(`native Header assertion HTTP/${version} rejects duplicate, array, overflow and projection loss rather than proving absence`, async (t) => {
    for (const sample of [
      {
        name: "duplicate",
        fields: ["X-Token", "first", "x-token", "second", "X-Token", "third"],
        selected: "x-token",
        code: "delete response.headers['x-token'];",
      },
      {
        name: "rewrite duplicate",
        fields: ["x-token", "first", "x-token", "second"],
        selected: "x-token",
        code: "response.headers['x-token']='single';",
      },
      {
        name: "single cookie",
        fields: ["set-cookie", "a=one"],
        selected: "set-cookie",
      },
      {
        name: "overflow",
        fields: [
          "x-token",
          "one",
          ...Array.from({ length: 300 }, (_, i) => ["x" + i, "v"]).flat(),
        ],
        selected: "missing",
      },
      ...(version === "1.1"
        ? [
            {
              name: "saturated parser",
              fields: [
                "x-token",
                "one",
                ...Array.from({ length: 1100 }, () => ["z", "v"]).flat(),
                "x-token",
                "hidden",
              ],
              selected: "x-token",
            },
            {
              name: "lost projection",
              fields: ["__proto__", "wire"],
              selected: "__proto__",
            },
          ]
        : []),
    ])
      await t.test(sample.name, async (t) => {
        const pending = fixture(t, version, (_req, res) => {
          if (version === "1.1") res.writeHead(200, sample.fields);
          else {
            for (let i = 0; i < sample.fields.length; i += 2) {
              const name = sample.fields[i].toLowerCase(),
                value = sample.fields[i + 1],
                prior = res.getHeader(name);
              res.setHeader(
                name,
                prior === undefined
                  ? value
                  : [...(Array.isArray(prior) ? prior : [prior]), value],
              );
            }
          }
          res.end("not JSON");
        });
        if (version === "2" && sample.name === "overflow") {
          await assert.rejects(pending, /HTTP2|NGHTTP2/);
          return;
        }
        const response = await pending;
        await assert.rejects(
          phase(response, [
            ...(sample.code ? [script(sample.code)] : []),
            assertion(sample.selected, "undefined"),
          ]),
          /传输证据|字符串|初始映射/,
        );
      });
  });

test("native Header assertion trusted completion, soft failure evidence, claimed indices and shared quotas resist tampering", async (t) => {
  const response = await fixture(t);
  for (const tasks of [
    [script("return;"), assertion("x-token", "wire-token")],
    [
      script("try {"),
      assertion("set-cookie", "undefined"),
      script("} catch {}"),
    ],
  ]) {
    if (tasks[1].data.expression.path === "set-cookie")
      tasks.unshift(script("response.headers['set-cookie']=['forged'];"));
    await assert.rejects(phase(response, tasks), /未完成/);
  }
  for (const code of [
    "tests[1]=tests[0];tests[0].passed=true;",
    "tests.length=0;",
    'tests.toJSON=()=>[];Object.prototype.toJSON=function(){return {passed:true};};JSON.stringify=()=>\'{"tests":[],"variables":{},"scopes":{"environment":{},"globals":{},"runtime":{},"defaults":{},"hidden":[]},"localVariables":{},"request":{},"logs":[]}\';',
    "Object.defineProperty(Array.prototype,'0',{configurable:true,set(){},get(){return {passed:true}}});Object.prototype.passed=true;",
  ]) {
    const result = await phase(response, [
      assertion("x-token", "wrong"),
      assertion("x-token", "wire-token"),
      script(code),
    ]);
    assert(result.tests.some((entry) => entry.passed === false));
    assert(
      result.tests.filter((entry) => entry.name === "x-token").length >= 2,
    );
  }
  await assert.rejects(
    phase(response, [
      script('for(let i=0;i<1000;i++)pm.test.skip("existing");'),
      assertion("x-token", "wire-token"),
    ]),
    /最多1000条/,
  );
  await assert.rejects(
    async () =>
      phase(
        response,
        [
          assertion("x-token", "wire-token"),
          script("tests.length=0;"),
          assertion("x-token", "wire-token"),
        ],
        { assertionLimit: 1 },
      ),
    /断言预算/,
  );
});

test("native Header evidence errors occur at task execution, not bootstrap", () => {
  const install = vm.runInNewContext(`(${nativeAssertionsInstallerSource})`);
  for (const proof of [
    { complete: false },
    { complete: true, counts: { "x-token": 2 } },
    { complete: true, counts: { "x-lost": 1 } },
  ]) {
    let registered = 0;
    const selected = proof.counts?.["x-lost"] ? "x-lost" : "x-token";
    const state = install(
      JSON.stringify(
        compileNativeAssertions([
          { name: "deferred", data: data(selected, "undefined") },
        ]),
      ),
      () => {
        throw Error("body reader");
      },
      () => registered++,
      [],
      { "x-token": "current" },
      JSON.stringify(proof),
    );
    assert.equal(registered, 0);
    assert.throws(() => state.run(0), /传输证据|初始映射/);
    assert.throws(() => state.assertComplete(), /未完成/);
    assert.equal(registered, 0);
  }
});

test("native Header assertion cannot bypass existing 1MiB output bound", async (t) => {
  const response = await fixture(t);
  await assert.rejects(
    phase(response, [
      assertion("x-token", "wire-token"),
      script("pm.environment.set('large','x'.repeat(1024*1024));"),
    ]),
    /输出|过大|超限/,
  );
});
