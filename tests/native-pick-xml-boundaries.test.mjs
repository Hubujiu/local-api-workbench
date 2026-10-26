import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import {
  normalizePickVarsData,
  compilePickVarsOperations,
} from "../src/native-response-extraction.mjs";
const row = (name, expression = "string(/login/token)", type = "envVars") => ({
  name,
  expression,
  type,
});
const data = (variables) => ({ source: "responseXml", variables });
const pick = (variables = [row("token")], enabled = 1) => ({
  type: "pickVars",
  enabled,
  data: data(variables),
});
const script = (code) => ({ type: "customScript", enabled: 1, data: code });
const input = (body = "<login><token>real</token></login>") => ({
  request: {},
  response: { status: 200, body },
  variables: { token: "old" },
});
const phase = (body, tasks = [pick()]) =>
  runNativeTaskPhase(tasks, input(body));

test("native XML compiles only bounded string(P) and never compiles disabled retained declarations", () => {
  assert.equal(
    compilePickVarsOperations([
      data([row("token", " string(/login/token) ")]),
    ])[0].variables[0].xmlPath,
    "/login/token",
  );
  for (const expression of [
    "",
    "/login/token",
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
    "string( /login/token )",
    "STRING(/login/token)",
    "string(/" + Array(33).fill("a").join("/") + ")",
  ])
    assert.throws(
      () => normalizePickVarsData(data([row("token", expression)])),
      /XML/,
    );
  assert.throws(() =>
    normalizePickVarsData(
      data([row("token", "string(/" + "a".repeat(1001) + ")")]),
    ),
  );
  const inert = data([row("", "{{anything}}")]);
  assert.deepEqual(normalizePickVarsData(inert, { enabled: false }), inert);
  assert.throws(() =>
    normalizePickVarsData({ ...inert, extra: 1 }, { enabled: false }),
  );
});

test("native XML private bundle and MIT notices reproduce byte-for-byte from pinned reviewed inputs", async () => {
  execFileSync(process.execPath, ["scripts/build-native-xml.mjs", "--check"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "pipe",
  });
  const manifest = JSON.parse(
    await readFile(
      new URL("../src/vendor/native-xml-library.json", import.meta.url),
    ),
  );
  assert.deepEqual(manifest.versions, {
    "@xmldom/xmldom": "0.9.12",
    xpath: "0.0.35",
  });
  const attributes = await readFile(
    new URL("../.gitattributes", import.meta.url),
    "utf8",
  );
  for (const line of [
    "/scripts/sandbox-intrinsic-guard.mjs text eol=lf",
    "/scripts/sandbox-native-xml-entry.mjs text eol=lf",
    "/src/native-xml-path.mjs text eol=lf",
    "/src/vendor/native-xml-library.js -text",
    "/src/vendor/native-xml-library.json -text",
    "/src/vendor/NATIVE-XML-LICENSES.txt -text",
  ])
    assert(attributes.split("\n").includes(line), line);
});

test("native XML reads only own body data, does not expose DOM/require, and preserves exact scalar text", async () => {
  const result = await phase(
    '<login token="a&amp;b"><token><![CDATA[&raw]]>&amp;&#65;</token><empty/></login>',
    [
      pick([
        row("token"),
        row("attr", "string(/login/@token)"),
        row("empty", "string(/login/empty)"),
      ]),
      script(
        `pm.test('private XML',()=>{pm.expect(typeof DOMParser).to.equal('undefined');pm.expect(typeof NativeXMLLibrary).to.equal('undefined');pm.expect(typeof __readNativeXML).to.equal('undefined');pm.expect(typeof readXML).to.equal('undefined');for(const name of ['xpath','xmldom','@xmldom/xmldom']){let failed=false;try{require(name)}catch{failed=true}pm.expect(failed).to.equal(true);}});`,
      ),
    ],
  );
  assert.equal(result.scopes.environment.token, "&raw&A");
  assert.equal(result.scopes.environment.attr, "a&b");
  assert.equal(result.scopes.environment.empty, "");
  assert(result.tests.every((entry) => entry.passed));
  await assert.rejects(
    phase(undefined, [
      script(
        "Object.defineProperty(response,'body',{get(){throw Error('body getter invoked');}});",
      ),
      pick(),
    ]),
    /自有字符串/,
  );
});

test("native XML keeps exact UTF8, depth and combined node/attribute bounds within existing VM budgets", async () => {
  const prefix = "<login><token>",
    suffix = "</token></login>";
  const exact =
    prefix + "x".repeat(65536 - prefix.length - suffix.length) + suffix;
  const ascii = await phase(exact);
  assert.equal(
    ascii.scopes.environment.token.length,
    65536 - prefix.length - suffix.length,
  );
  assert(ascii.activityMs <= 250);
  const utf8 =
    prefix +
    "雪".repeat(Math.floor((65536 - prefix.length - suffix.length) / 3)) +
    suffix;
  assert.equal(
    (await phase(utf8)).scopes.environment.token.length,
    utf8.length - prefix.length - suffix.length,
  );
  await assert.rejects(phase(exact + " "), /64KiB/);
  await assert.rejects(phase(prefix + "雪".repeat(21846) + suffix), /64KiB/);
  await assert.rejects(phase(prefix + "\ud800" + suffix), /Unicode/);
  const nested = "<a>".repeat(32) + "leaf" + "</a>".repeat(32);
  assert.equal(
    (
      await phase(nested, [
        pick([row("token", "string(/" + Array(32).fill("a").join("/") + ")")]),
      ])
    ).scopes.environment.token,
    "leaf",
  );
  await assert.rejects(
    phase("<a>".repeat(33) + "leaf" + "</a>".repeat(33)),
    /深度/,
  );
  // Document + login + token + text + 1996 empty sibling elements = 2,000.
  const many = "<login><token>ok</token>" + "<x/>".repeat(1996) + "</login>";
  assert.equal((await phase(many)).scopes.environment.token, "ok");
  await assert.rejects(phase(many.replace("</login>", "<x/></login>")), /节点/);
  const attrs =
    "<login><token>ok</token>" + '<x a=""/>'.repeat(999) + "</login>";
  await assert.rejects(phase(attrs), /节点|属性/);
});

test("native XML rejects malformed, XML control characters and namespace-bearing documents", async () => {
  for (const body of [
    "",
    "<login><token></login>",
    "<login><token>&unknown;</token></login>",
    "<login><token>\u0000</token></login>",
    "<login><token>&#0;</token></login>",
    "<login><token>&#xD800;</token></login>",
    "<login><token>&#xFFFF;</token></login>",
    "<login><token>&#x110000;</token></login>",
    '<login xmlns="urn:x"><token>value</token></login>',
    '<login xmlns=""><token>value</token></login>',
    '<login xml:lang="en"><token>value</token></login>',
    "<!DOCTYPE login><login><token>value</token></login>",
    "<login><token><![CDATA[<!DOCTYPE x>]]></token></login>",
  ])
    await assert.rejects(phase(body), /XML/);
});

test("native XML checks the complete intrinsic graph before each task without invoking injected getters", async () => {
  const mutations = [
    "globalThis.Object=function(){};",
    "globalThis.Error=function(){return {message:'fake'}};",
    "Object.prototype.value='forged';",
    "Object.defineProperty(Object.prototype,'value',{get(){throw Error('getter invoked')}});",
    "Object.defineProperty(Array.prototype,'0',{set(){throw Error('array setter invoked')}});",
    "Object.prototype.hasOwnProperty.call=()=>true;",
    "String.prototype.charAt=()=>'<';",
    "RegExp.prototype.exec=()=>null;",
    "RegExp.prototype[Symbol.match]=()=>[];",
    "Array.prototype[Symbol.iterator]=function*(){};",
    "Object.getPrototypeOf([].values()).next=()=>({done:true});",
    "Object.getPrototypeOf(''[Symbol.iterator]()).next=()=>({done:true});",
    "Object.getPrototypeOf(new Map().entries()).next=()=>({done:true});",
    "Object.setPrototypeOf(String.prototype,{});",
    "Object.defineProperty(globalThis,'String',{get(){throw Error('global getter invoked')}});",
  ];
  for (const mutation of mutations)
    await assert.rejects(
      phase(undefined, [script(mutation), pick()]),
      /XML内建对象/,
    );
  await assert.rejects(
    phase(undefined, [
      pick(),
      script("Number.parseInt.call=()=>0;"),
      pick([row("again")]),
    ]),
    /XML内建对象/,
  );
  const context = vm.createContext({
    response: { body: "<login><token>ok</token></login>" },
  });
  vm.runInContext(
    await readFile(
      new URL("../src/vendor/native-xml-library.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  vm.runInContext(
    "var readXML=NativeXMLLibrary.createNativeXMLExtractor(response);var getterCalls=0;Object.defineProperty(Object.prototype,'value',{get(){getterCalls++;return 1;}});",
    context,
  );
  assert.throws(() => vm.runInContext("readXML()", context), /XML内建对象/);
  assert.equal(context.getterCalls, 0);
});

test("disabled XML is inert and unrelated JSON/header tasks do not load the strict XML guard", async () => {
  const result = await phase('{"token":"json"}', [
    script("Object.prototype.extra='permitted for legacy JSON';"),
    pick([row("", "{{invalid}}")], 0),
    {
      type: "pickVars",
      enabled: 1,
      data: { source: "responseJson", variables: [row("token", "$.token")] },
    },
  ]);
  assert.equal(result.scopes.environment.token, "json");
});

test("native XML repeated tasks share the original phase activity budget without a per-parser reset", async () => {
  const body = "<login><token>ok</token>" + "<x/>".repeat(1996) + "</login>";
  await assert.rejects(
    phase(
      body,
      Array.from({ length: 16 }, () => pick()),
    ),
    (error) => {
      assert.match(error.message, /超时/);
      assert.equal(error.scriptDiagnostics.activityBudgetMs, 250);
      assert.equal(error.networkRequests.length, 0);
      return true;
    },
  );
});

test("native XML preserves literal numeric-reference text in CDATA comments and processing instructions", async () => {
  const body =
    '<login note="valid &amp; text"><!-- &#0; &#xD800; --><?note &#x110000;?><token><![CDATA[&#0; &#xD800; &#xFFFF; &#x110000;]]></token></login>';
  const result = await phase(body);
  assert.equal(
    result.scopes.environment.token,
    "&#0; &#xD800; &#xFFFF; &#x110000;",
  );
  for (const bad of [
    "<login><token>&#0;</token></login>",
    '<login bad="&#xD800;"><token>ok</token></login>',
    "<login><!-- benign &#0; --><token>&#x110000;</token></login>",
  ])
    await assert.rejects(phase(bad), /XML.*字符/);
});
