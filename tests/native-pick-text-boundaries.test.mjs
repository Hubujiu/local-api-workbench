import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  normalizePickVarsData,
  compilePickVarsOperations,
  pickVarsInstallerSource,
} from "../src/native-response-extraction.mjs";
import { nativeResponseTextReaderSource } from "../src/native-response-text.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { resolveDynamicRequest } from "../src/dynamic-values.mjs";
import { interpolate } from "../src/core.mjs";
import { normalizeNativeTaskRequest } from "../src/script-database-tasks.mjs";
const row = (name, type = "envVars") => ({ name, type });
const data = (variables) => ({ source: "responseText", variables });
const pick = (variables = [row("token")], enabled = 1) => ({
  type: "pickVars",
  enabled,
  data: data(variables),
});
const script = (code) => ({ type: "customScript", enabled: 1, data: code });
const phase = (body, tasks = [pick()]) =>
  runNativeTaskPhase(tasks, {
    request: {},
    response: { status: 200, body },
    variables: { token: "old" },
  });

test("native Text retains optional inert expressions and raw names but compiles trimmed safe names", () => {
  const source = data([
    row(" token "),
    {
      ...row(" other ", "globalVars"),
      expression: " {{unexecuted}} $.bad[.*] string(//node) ",
    },
    { ...row("emptyExpression", "tempVars"), expression: "" },
  ]);
  assert.deepEqual(normalizePickVarsData(source), source);
  assert.deepEqual(compilePickVarsOperations([source]), [
    {
      source: "responseText",
      variables: [
        { name: "token", scope: "environment" },
        { name: "other", scope: "global" },
        { name: "emptyExpression", scope: "temporary" },
      ],
    },
  ]);
  for (const name of [
    "",
    " \t ",
    " __proto__ ",
    " constructor ",
    " prototype ",
  ])
    assert.throws(() => normalizePickVarsData(data([row(name)])), /变量名/);
  for (const source of ["responseJson", "responseHeader", "responseXml"])
    assert.throws(
      () => normalizePickVarsData({ source, variables: [row("token")] }),
      /自有字段/,
    );
  const inert = data([
    { ...row(" __proto__ "), expression: "{{not executed}}" },
  ]);
  assert.deepEqual(normalizePickVarsData(inert, { enabled: false }), inert);
  assert.doesNotThrow(() =>
    normalizeNativeTaskRequest({
      inheritSharedScripts: false,
      nativeTasks: {
        version: 1,
        before: [pick(inert.variables, 0)],
        after: [],
      },
    }),
  );
  assert.throws(
    () =>
      normalizeNativeTaskRequest({
        inheritSharedScripts: false,
        nativeTasks: { version: 1, before: [pick()], after: [] },
      }),
    /后置/,
  );
});

test("native Text retains closed data limits and rejects present invalid expressions without invoking getters", () => {
  for (const expression of [
    undefined,
    null,
    42,
    {},
    "x".repeat(1001),
    "\ud800",
  ])
    for (const enabled of [false, true])
      assert.throws(() =>
        normalizePickVarsData(data([{ ...row("token"), expression }]), {
          enabled,
        }),
      );
  for (const variables of [
    Array(1),
    Array.from({ length: 101 }, () => row("token")),
  ])
    assert.throws(() => normalizePickVarsData(data(variables)));
  assert.throws(() =>
    compilePickVarsOperations(Array.from({ length: 17 }, () => data([]))),
  );
  assert.throws(() =>
    normalizePickVarsData(
      data(
        Array.from({ length: 100 }, () => ({
          ...row("token"),
          expression: "x".repeat(1000),
        })),
      ),
    ),
  );
  assert.throws(() =>
    normalizePickVarsData({
      source: "unsupportedResponseSource",
      variables: [],
    }),
  );
  let calls = 0;
  for (const property of ["expression", "hidden"]) {
    const variable = row("token");
    Object.defineProperty(variable, property, {
      enumerable: property === "expression",
      get() {
        calls++;
        return "ignored";
      },
    });
    assert.throws(() => normalizePickVarsData(data([variable])));
  }
  for (const property of ["name", "type"]) {
    const variable = row("token");
    delete variable[property];
    Object.defineProperty(Object.prototype, property, {
      configurable: true,
      get() {
        calls++;
        return "forged";
      },
    });
    try {
      assert.throws(() => normalizePickVarsData(data([variable])));
    } finally {
      delete Object.prototype[property];
    }
  }
  Object.defineProperty(Object.prototype, "expression", {
    configurable: true,
    get() {
      calls++;
      return "inherited";
    },
  });
  try {
    assert.deepEqual(
      normalizePickVarsData(data([row("token")])),
      data([row("token")]),
    );
  } finally {
    delete Object.prototype.expression;
  }
  assert.equal(calls, 0);
});

test("native Text reader is own-data-only, captures intrinsics, and never calls a body getter", () => {
  const context = vm.createContext({});
  vm.runInContext(
    `var response={body:' initial '};var read=(${nativeResponseTextReaderSource})(response);var calls=0;`,
    context,
  );
  assert.equal(vm.runInContext("read()", context), " initial ");
  vm.runInContext(
    "Object.getOwnPropertyDescriptor=()=>({value:'forged',enumerable:true});Object.hasOwn=()=>true;String.prototype.charCodeAt=()=>65;Error=()=>{throw 'public Error called'};",
    context,
  );
  for (const modification of [
    "delete response.body;",
    "response.body=undefined;",
    "response.body=42;",
    "response.body={toString(){calls++;return 'forged'}};",
    "Object.defineProperty(response,'body',{configurable:true,enumerable:false,value:'hidden'});",
    "Object.defineProperty(response,'body',{configurable:true,enumerable:true,get(){calls++;return 'getter'}});Object.prototype.value='forged';",
  ]) {
    vm.runInContext(modification, context);
    assert.throws(() => vm.runInContext("read()", context), /自有字符串/);
  }
  assert.equal(vm.runInContext("calls", context), 0);
});

test("native Text reads once per task and prepares all rows before any setter", () => {
  const operations = compilePickVarsOperations([
    data([row("one"), row("two", "globalVars"), row("three", "tempVars")]),
    data([]),
  ]);
  const context = vm.createContext({
    operations: JSON.stringify(operations),
    pickVarsInstallerSource,
    nativeResponseTextReaderSource,
  });
  vm.runInContext(
    `var calls=0, writes=[];var current='original';var reader=()=>{calls++;return current;};var setter=(name,value)=>{writes.push([name,value]);current='changed';};var state=(${pickVarsInstallerSource})(operations,()=>{}, {},'null',setter,setter,setter,null,reader);state.run(0);state.run(1);state.assertComplete();`,
    context,
  );
  assert.equal(context.calls, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(context.writes)), [
    ["one", "original"],
    ["two", "original"],
    ["three", "original"],
  ]);
});

test("native Text uses the current whole body without templates parsing public readers or XML initialization", async () => {
  const result = await phase("wire token", [
    script(
      "apt.response.setBody('  雪 😀 <broken {{literal}}  ');pm.response.text=()=>{throw Error('public text called')};Object.prototype.unrelated='allowed';",
    ),
    pick([
      { ...row(" token "), expression: "{{not a selector}}" },
      row("globalToken", "globalVars"),
      row("temporaryToken", "tempVars"),
    ]),
    script(
      "pm.test('private text reader',()=>{pm.expect(typeof readText).to.equal('undefined');pm.expect(typeof createNativeResponseTextReader).to.equal('undefined');pm.expect(typeof NativeXMLLibrary).to.equal('undefined');pm.expect(response.raw.responseText).to.equal('wire token');pm.expect(pm.variables.get('temporaryToken')).to.equal(pm.environment.get('token'));});",
    ),
  ]);
  assert.equal(
    result.scopes.environment.token,
    "  雪 😀 <broken {{literal}}  ",
  );
  assert.equal(
    result.scopes.globals.globalToken,
    result.scopes.environment.token,
  );
  assert(result.tests.every((entry) => entry.passed));
  const changed = await phase("first", [
    pick([row("first")]),
    script("response.body='second';"),
    pick([row("second")]),
  ]);
  assert.equal(changed.scopes.environment.first, "first");
  assert.equal(changed.scopes.environment.second, "second");
});

test("native Text preserves empty whitespace and exact valid UTF8 limits without coercing invalid bodies", async () => {
  for (const body of [
    "",
    " \r\n\t ",
    "\u0000literal non-XML",
    "x".repeat(65536),
    "😀".repeat(16384),
  ]) {
    const result = await phase(body);
    assert.equal(result.scopes.environment.token, body);
  }
  for (const body of [
    "x".repeat(65537),
    "😀".repeat(16384) + "x",
    "雪".repeat(21846),
    "\ud800",
    "\udc00",
  ])
    await assert.rejects(phase(body), /64KiB|Unicode/);
  for (const code of [
    "delete response.body;",
    "response.body=null;",
    "response.body=42;",
    "response.body={toString(){throw Error('coercion')}};",
    "Object.defineProperty(response,'body',{get(){throw Error('getter called')}});",
  ])
    await assert.rejects(phase("wire", [script(code), pick()]), /自有字符串/);
});

test("native task declarations never participate in HTTP template interpolation", async () => {
  const nativeTasks = {
    version: 1,
    before: [],
    after: [
      pick([{ ...row("token"), expression: "{{not a selector}}" }]),
      pick([{ ...row("inert"), expression: "{{undefined}}" }], 0),
      script("pm.environment.set('literal','{{explicit-only}}');"),
    ],
  };
  const request = {
    url: "http://example.test/{{route}}",
    headers: [{ name: "x-route", value: "{{route}}" }],
    body: "{{route}}",
    nativeTasks,
    importedScriptTasks: [{ data: "{{not evaluated}}" }],
    importedNativeTaskSource: { source: "{{not evaluated}}" },
  };
  const resolved = await resolveDynamicRequest(
    request,
    { route: "login" },
    [],
    interpolate,
  );
  assert.equal(resolved.url, "http://example.test/login");
  assert.equal(resolved.headers[0].value, "login");
  assert.equal(resolved.body, "login");
  assert.deepEqual(resolved.importedScriptTasks, request.importedScriptTasks);
  assert.deepEqual(
    resolved.importedNativeTaskSource,
    request.importedNativeTaskSource,
  );
  assert.deepEqual(resolved.nativeTasks, nativeTasks);
  assert.deepEqual(request.nativeTasks, nativeTasks);
  assert.notEqual(resolved.nativeTasks, nativeTasks);
});
