import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { withWorkerRejectionDiagnostics } from "./helpers/worker-rejection-diagnostics.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { normalizeNativeTaskRequest } from "../src/script-database-tasks.mjs";
import {
  compileNativeAssertions,
  normalizeNativeAssertionData,
} from "../src/native-response-assertions.mjs";
const data = (
  path = "string(/login/token)",
  compareValue = "real",
  compareType = "eq",
) => ({ type: "responseXml", expression: { path, compareValue, compareType } });
const assertion = (path, expected, compareType = "eq") => ({
  type: "assert",
  enabled: 1,
  name: "XML " + (path || "default"),
  data: data(path, expected, compareType),
});
const script = (code) => ({ type: "customScript", enabled: 1, data: code });
const pick = () => ({
  type: "pickVars",
  enabled: 1,
  data: {
    source: "responseXml",
    variables: [
      { name: "picked", expression: "string(/login/token)", type: "envVars" },
    ],
  },
});
const phase = (body, tasks = [assertion()], options) =>
  runNativeTaskPhase(
    tasks,
    { request: {}, response: { status: 200, body } },
    options,
  );

test("native XML assertions preserve stored path but compile only bounded string(P) with outer whitespace", () => {
  const original = data(" \nstring(/login/@token)\t", "");
  assert.deepEqual(normalizeNativeAssertionData(original), original);
  assert.equal(
    compileNativeAssertions([{ name: "XML", data: original }])[0].xmlPath,
    "/login/@token",
  );
  for (const path of [
    "",
    "/login/token",
    "string( /login/token )",
    "string(//token)",
    "string(/login/*)",
    "string(/login/token[1])",
    "string(/login/token/text())",
    "string(/login/../token)",
    "string(/p:login/token)",
    "string(/登录/token)",
    "string(/login/@token/value)",
    "count(/login/token)",
    "boolean(/login/token)",
    "string({{path}})",
    "string(/login/token)|/other",
    "STRING(/login/token)",
    "string(/" + Array(33).fill("a").join("/") + ")",
    "string(/" + "a".repeat(1001) + ")",
  ])
    assert.throws(
      () => normalizeNativeAssertionData(data(path)),
      /XML|模板|字面/,
    );
  for (const invalid of [
    data(undefined, ["{{expected}}"]),
    data(undefined, 0),
    data(undefined, "real", "contains"),
    data(undefined, "x".repeat(65536)),
  ])
    assert.throws(() => normalizeNativeAssertionData(invalid));
  const inert = {
    type: "responseXml",
    expression: { path: "count({{unknown}})", compareValue: "{{unknown}}" },
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
        nativeTasks: { version: 1, before: [assertion()], after: [] },
      }),
    /后置/,
  );
});

test("native XML assertions compare exact leaf, attribute, empty and CDATA/entity scalar strings", async () => {
  const result = await phase(
    '<login token="a&amp;b"><token><![CDATA[雪 &#0;]]>&amp;&#65;</token><empty/><zero>0</zero><false>false</false></login>',
    [
      assertion("string(/login/token)", "雪 &#0;&A"),
      assertion("string(/login/@token)", "a&b"),
      assertion("string(/login/empty)", ""),
      assertion("string(/login/zero)", "0"),
      assertion("string(/login/false)", "false"),
      assertion(" string(/login/token) ", "other", "uneq"),
    ],
  );
  assert.equal(result.tests.length, 6);
  assert(result.tests.every((entry) => entry.passed));
});

test("native XML assertions read current body without reading code or demanding Header transport evidence", async () => {
  const result = await phase("<login><token>wire</token></login>", [
    script(
      `let codeReads=0;const descriptor=Object.getOwnPropertyDescriptor(pm.response,'code');Object.defineProperty(pm.response,'code',{configurable:true,get(){codeReads++;throw Error('code getter invoked');}});pm.response.text=()=>{throw Error('public text called');};apt.response.setBody('<login><token>current</token></login>');`,
    ),
    assertion("string(/login/token)", "current"),
    script(
      "Object.defineProperty(pm.response,'code',descriptor);pm.environment.set('codeReads',codeReads);",
    ),
  ]);
  assert.equal(result.tests[0].passed, true);
  assert.equal(result.scopes.environment.codeReads, 0);
  assert.equal(
    result.responseOverride.body,
    "<login><token>current</token></login>",
  );
  await withWorkerRejectionDiagnostics((captureRejection) =>
    assert.rejects(
      phase("<login><token>wire</token></login>", [
        script(
          "Object.defineProperty(response,'body',{get(){throw Error('body getter invoked');}});",
        ),
        assertion(),
      ]).catch(captureRejection),
      /自有字符串/,
    ),
  );
});

test("mixed native XML assertions and pick use one private factory and observe body changes at each task", async () => {
  const worker = await readFile(
    new URL("../src/script-worker.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(
    worker.split("NativeXMLLibrary.createNativeXMLExtractor(response)").length -
      1,
    1,
  );
  const result = await phase("<login><token>first</token></login>", [
    assertion("string(/login/token)", "first"),
    pick(),
    script(
      "pm.environment.set('first',pm.environment.get('picked'));apt.response.setBody('<login><token>second</token></login>');",
    ),
    assertion("string(/login/token)", "second"),
    pick(),
    script(
      "pm.test('private XML remains private',()=>{pm.expect(typeof DOMParser).to.equal('undefined');pm.expect(typeof NativeXMLLibrary).to.equal('undefined');pm.expect(typeof readXML).to.equal('undefined');pm.expect(typeof __readNativeXML).to.equal('undefined');});",
    ),
  ]);
  assert.equal(result.scopes.environment.first, "first");
  assert.equal(result.scopes.environment.picked, "second");
  assert(result.tests.every((entry) => entry.passed));
  assert(result.activityMs <= 250);
});

test("native XML selection and parse errors remain stage errors rather than null/empty comparisons", async () => {
  for (const body of [
    "",
    "<login><token></login>",
    "<login><token>&unknown;</token></login>",
    "<login><token>&#0;</token></login>",
    "<login><token>&#xD800;</token></login>",
    "<!DOCTYPE login><login><token>real</token></login>",
    '<login xmlns="urn:x"><token>real</token></login>',
    "<login/>",
    "<login><token>one</token><token>two</token></login>",
    "<login><token><nested>real</nested></token></login>",
  ])
    await assert.rejects(
      phase(body, [assertion("string(/login/token)", "null")]),
      /XML/,
    );
  await assert.rejects(
    phase("<login/>", [assertion("string(/login/@missing)", "")]),
    /恰好/,
  );
  await assert.rejects(
    phase("<login/>", [
      script("try {"),
      assertion("string(/login/token)", "null"),
      script("} catch {}"),
    ]),
    /未完成/,
  );
  await assert.rejects(
    phase("<login><token>real</token></login>", [
      script("return;"),
      assertion(),
    ]),
    /未完成/,
  );
  const result = await phase("<login><token>real</token></login>", [
    assertion(undefined, "wrong"),
    script("pm.environment.set('after','yes');"),
    assertion(),
  ]);
  assert.deepEqual(
    result.tests.map((entry) => entry.passed),
    [false, true],
  );
  assert.equal(result.scopes.environment.after, "yes");
});

test("native XML assertion input, node/attribute and depth budgets match the shared extraction parser", async () => {
  const prefix = "<login><token>",
    suffix = "</token></login>";
  const exact =
    prefix + "x".repeat(65536 - prefix.length - suffix.length) + suffix;
  assert.equal(
    (await phase(exact, [assertion(undefined, "short", "uneq")])).tests[0]
      .passed,
    true,
  );
  await assert.rejects(phase(exact + " "), /64KiB/);
  await assert.rejects(phase(prefix + "雪".repeat(21846) + suffix), /64KiB/);
  await assert.rejects(phase(prefix + "\ud800" + suffix), /Unicode/);
  const nested = "<a>".repeat(32) + "leaf" + "</a>".repeat(32),
    selected = "string(/" + Array(32).fill("a").join("/") + ")";
  assert.equal(
    (await phase(nested, [assertion(selected, "leaf")])).tests[0].passed,
    true,
  );
  await assert.rejects(
    phase("<a>".repeat(33) + "leaf" + "</a>".repeat(33)),
    /深度/,
  );
  const many = "<login><token>real</token>" + "<x/>".repeat(1996) + "</login>";
  assert.equal((await phase(many)).tests[0].passed, true);
  await assert.rejects(phase(many.replace("</login>", "<x/></login>")), /节点/);
  await assert.rejects(
    phase("<login><token>real</token>" + '<x a=""/>'.repeat(999) + "</login>"),
    /节点|属性/,
  );
});

test("native XML assertions retain shared test and output budgets", async () => {
  const body = "<login><token>real</token></login>";
  await assert.rejects(
    phase(body, [
      script('for(let i=0;i<1000;i++)pm.test.skip("prior");'),
      assertion(),
    ]),
    /最多1000条/,
  );
  await assert.rejects(
    async () => phase(body, [assertion(), assertion()], { assertionLimit: 1 }),
    /断言预算/,
  );
  await assert.rejects(
    phase(body, [
      assertion(),
      script("pm.environment.set('large','x'.repeat(1024*1024));"),
    ]),
    /输出|过大|超限/,
  );
});
