import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { executeRequest } from "../src/runtime.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { normalizeNativeTaskRequest } from "../src/script-database-tasks.mjs";
import {
  compileNativeAssertions,
  normalizeNativeAssertionData,
} from "../src/native-response-assertions.mjs";
const data = (compareValue = "real", compareType = "eq", extra = {}) => ({
  type: "responseText",
  expression: { compareValue, compareType, ...extra },
});
const assertion = (expected = "real", comparison = "eq", extra = {}) => ({
  type: "assert",
  enabled: 1,
  name: "native " + comparison,
  data: data(expected, comparison, extra),
});
const from = (type, path, expected, comparison) => ({
  ...assertion(expected, comparison, { path }),
  data: {
    type,
    expression: { path, compareValue: expected, compareType: comparison },
  },
});
const script = (code) => ({ type: "customScript", enabled: 1, data: code });
const phase = (body, tasks = [assertion()], options) =>
  runNativeTaskPhase(
    tasks,
    { request: {}, response: { status: 200, body } },
    options,
  );
const pick = () => ({
  type: "pickVars",
  enabled: 1,
  data: {
    source: "responseText",
    variables: [{ name: "picked", type: "envVars" }],
  },
});

test("native Text assertion keeps optional inert diagnostic paths and closes active expected/comparator semantics", () => {
  for (const sample of [
    data(),
    data("real", "includes", { path: "  {{inert.path}} [not-selector]  " }),
    data("real", "unincludes", { path: "" }),
  ]) {
    assert.deepEqual(normalizeNativeAssertionData(sample), sample);
    assert.equal(
      compileNativeAssertions([{ name: "Text", data: sample }])[0].type,
      "responseText",
    );
  }
  const missingPath = normalizeNativeAssertionData(data());
  assert(!Object.hasOwn(missingPath.expression, "path"));
  for (const sample of [
    data(42),
    data("real", "regex"),
    data("real", "unsupportedComparison"),
    data("real", "empty"),
    data("real", "eq", { path: undefined }),
    data("real", "eq", { path: 4 }),
    data("real", "eq", { path: "x".repeat(1001) }),
    data("real", "eq", { path: "\ud800" }),
    data("x".repeat(65536)),
  ])
    assert.throws(() => normalizeNativeAssertionData(sample));
  const inert = {
    type: "responseText",
    expression: { compareValue: "{{not-expanded}}", path: "{{diagnostic}}" },
  };
  assert.deepEqual(
    normalizeNativeAssertionData(inert, { enabled: false }),
    inert,
  );
  assert.throws(() => normalizeNativeAssertionData(inert));
  for (const type of [
    "responseCode",
    "responseJson",
    "responseHeader",
    "responseXml",
  ])
    assert.throws(
      () =>
        normalizeNativeAssertionData({
          type,
          expression: { compareType: "includes", compareValue: "x" },
        }),
      /自有/,
    );
  assert.throws(
    () =>
      normalizeNativeTaskRequest({
        inheritSharedScripts: false,
        nativeTasks: { version: 1, before: [assertion()], after: [] },
      }),
    /后置/,
  );
});

test("native Text optional path ignores inherited getters but own accessor is rejected without invocation", () => {
  let reads = 0;
  Object.defineProperty(Object.prototype, "path", {
    configurable: true,
    get() {
      reads++;
      throw Error("inherited path");
    },
  });
  try {
    const result = normalizeNativeAssertionData(data());
    assert(!Object.hasOwn(result.expression, "path"));
    assert.equal(
      compileNativeAssertions([{ name: "Text", data: data() }])[0].diagnostic,
      "",
    );
  } finally {
    delete Object.prototype.path;
  }
  const sample = data();
  Object.defineProperty(sample.expression, "path", {
    enumerable: true,
    get() {
      reads++;
      throw Error("own path");
    },
  });
  assert.throws(() => normalizeNativeAssertionData(sample), /访问器/);
  assert.equal(reads, 0);
});

test("native includes/unincludes are case-sensitive exact String containment including empty and Unicode", async () => {
  const body = "  雪 Aé😀  ";
  const result = await phase(body, [
    assertion("雪 A", "includes"),
    assertion("aé", "includes"),
    assertion("😀", "includes"),
    assertion("e\u0301", "includes"),
    assertion("", "includes"),
    assertion("", "unincludes"),
    assertion("雪 A", "unincludes"),
    assertion("absent", "unincludes"),
    assertion("雪 Aé😀", "eq"),
    assertion(body, "eq"),
    assertion("other", "uneq"),
  ]);
  assert.deepEqual(
    result.tests.map((entry) => entry.passed),
    [true, false, true, false, true, false, false, true, false, true, true],
  );
  const empty = await phase("", [
    assertion("", "eq"),
    assertion("", "includes"),
    assertion("", "unincludes"),
    assertion("x", "unincludes"),
  ]);
  assert.deepEqual(
    empty.tests.map((entry) => entry.passed),
    [true, true, false, true],
  );
});

test("native Text reads current own string body, not code/Header proof/public text or an XML parser", async () => {
  const result = await phase("wire", [
    script(
      `const codeDescriptor=Object.getOwnPropertyDescriptor(pm.response,'code');let codeReads=0;Object.defineProperty(pm.response,'code',{configurable:true,get(){codeReads++;throw Error('code getter');}});pm.response.text=()=>{throw Error('public text called');};String.prototype.charAt=()=>{throw Error('XML-only intrinsic must not load');};apt.response.setBody('current 雪');`,
    ),
    assertion("雪", "includes"),
    pick(),
    script(
      "Object.defineProperty(pm.response,'code',codeDescriptor);pm.environment.set('codeReads',codeReads);",
    ),
  ]);
  assert.equal(result.tests[0].passed, true);
  assert.equal(result.scopes.environment.picked, "current 雪");
  assert.equal(result.scopes.environment.codeReads, 0);
  assert.equal(result.responseOverride.body, "current 雪");
  for (const mutation of [
    "delete response.body;",
    "response.body=undefined;",
    "response.body=null;",
    "response.body=42;",
    "response.body=['real'];",
    "response.body={toString(){throw Error('coercion');}};",
    "Object.defineProperty(response,'body',{get(){throw Error('body getter invoked');}});",
  ])
    await assert.rejects(
      phase("real", [script(mutation), assertion("undefined")]),
      /字符串|正文/,
    );
});

test("native generic containment works across Code JSON Header XML and Text without widening selected source values", async (t) => {
  const server = http.createServer((_req, res) => {
    res.setHeader("x-token", "token, value");
    res.setHeader("x-duplicate", ["one", "two"]);
    res.end('{"zero":0,"false":false,"nil":null}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const response = await executeRequest({
    url: `http://127.0.0.1:${server.address().port}/`,
  });
  const result = await runNativeTaskPhase(
    [
      from("responseCode", "", "00", "includes"),
      from("responseJson", "$.zero", "0", "includes"),
      from("responseJson", "$.false", "als", "includes"),
      from("responseJson", "$.nil", "NULL", "unincludes"),
      from("responseJson", "$.missing", "def", "includes"),
      from("responseHeader", "X-ToKeN", ", value", "includes"),
      from("responseHeader", "missing", "def", "includes"),
      script("apt.response.setBody('<root><value>XML 雪</value></root>');"),
      from("responseXml", "string(/root/value)", "雪", "includes"),
      from("responseXml", "string(/root/value)", "xml", "unincludes"),
      script("apt.response.setBody('Text 😀');"),
      assertion("😀", "includes"),
      assertion("Text", "unincludes"),
    ],
    { request: {}, response },
  );
  assert.deepEqual(
    result.tests.map((entry) => entry.passed),
    [true, true, true, true, true, true, true, true, true, true, false],
  );
  await assert.rejects(
    runNativeTaskPhase(
      [from("responseHeader", "x-duplicate", "", "includes")],
      { request: {}, response },
    ),
    /传输证据/,
  );
  for (const body of ['{"x":{}}', '{"x":[]}', '{"x":1e999}'])
    await assert.rejects(
      phase(body, [from("responseJson", "$.x", "", "includes")]),
      /有限JSON原始值/,
    );
  await assert.rejects(
    phase("<root/>", [
      from("responseXml", "string(/root/missing)", "", "includes"),
    ]),
    /恰好/,
  );
});

test("native containment captures indexOf and preserves authoritative soft failure despite public methods/results", async () => {
  const result = await phase("real", [
    script(
      "String.prototype.indexOf=()=>0;String.prototype.includes=()=>true;String=()=> 'forged';pm.test=()=>{};",
    ),
    assertion("absent", "includes"),
    assertion("real", "includes"),
    assertion("", "unincludes"),
    script("tests.length=0;pm.environment.set('after','yes');"),
  ]);
  assert.deepEqual(
    result.tests.map((entry) => entry.passed),
    [false, true, false],
  );
  assert.equal(result.scopes.environment.after, "yes");
  await assert.rejects(
    phase("real", [
      script("try { delete response.body;"),
      assertion("undefined", "includes"),
      script("}catch{}"),
    ]),
    /未完成/,
  );
  await assert.rejects(
    phase("real", [script("return;"), assertion()]),
    /未完成/,
  );
});

test("native Text assertion retains UTF8 64KiB, shared tests and output budgets", async () => {
  const exact = "雪".repeat(21845) + "x";
  assert.equal(Buffer.byteLength(exact), 65536);
  assert.equal(
    (await phase(exact, [assertion("雪", "includes")])).tests[0].passed,
    true,
  );
  for (const body of [
    "x".repeat(65537),
    "雪".repeat(21846),
    "\ud800",
    "\udc00",
  ])
    await assert.rejects(
      phase(body, [assertion("", "includes")]),
      /64KiB|Unicode/,
    );
  await assert.rejects(
    phase("real", [
      script('for(let i=0;i<1000;i++)pm.test.skip("prior");'),
      assertion(),
    ]),
    /最多1000条/,
  );
  await assert.rejects(
    async () =>
      phase("real", [assertion(), assertion()], { assertionLimit: 1 }),
    /断言预算/,
  );
  await assert.rejects(
    phase("real", [
      assertion(),
      script("pm.environment.set('large','x'.repeat(1024*1024));"),
    ]),
    /输出|过大|超限/,
  );
});

test("native Text diagnostics remain literal and Text does not inherit XML control-character restrictions", async () => {
  const diagnostic = " {{diagnostic-only}} [not selector] ";
  const result = await phase("body\0tail", [
    assertion("missing", "includes", { path: diagnostic }),
    assertion("\0", "includes"),
  ]);
  assert.equal(result.tests[0].passed, false);
  assert.equal(result.tests[0].error, diagnostic + ": 响应值不包含预期字符串");
  assert.equal(result.tests[1].passed, true);
});
