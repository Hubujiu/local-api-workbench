import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import {
  normalizePickVarsData,
  compilePickVarsOperations,
  pickVarsInstallerSource,
} from "../src/native-response-extraction.mjs";
const sources = {
  responseCode: "code",
  responseTime: "responseTime",
  responseSize: "responseSize",
};
const row = (name = "picked", type = "envVars") => ({ name, type });
const pick = (source, variables = [row()], enabled = 1) => ({
  type: "pickVars",
  enabled,
  data: { source, variables },
});
const script = (data) => ({ type: "customScript", enabled: 1, data });
const phase = (tasks) =>
  runNativeTaskPhase(tasks, {
    request: {},
    response: { status: 200, duration: 1.25, size: 4, body: "not JSON" },
    scopes: { environment: { old: "kept" }, globals: {}, runtime: {} },
  });

test("metadata preserves raw inert expressions, trims only destination names and stays post-only", async () => {
  for (const source of Object.keys(sources)) {
    const data = pick(source, [
      row(" token "),
      { ...row("other"), expression: "{{unused}} $[*]" },
    ]).data;
    assert.deepEqual(normalizePickVarsData(data), data);
    assert.deepEqual(compilePickVarsOperations([data])[0].variables, [
      { name: "token", scope: "environment" },
      { name: "other", scope: "environment" },
    ]);
    for (const name of [" ", " __proto__ ", " constructor ", " prototype "])
      assert.throws(() =>
        normalizePickVarsData(pick(source, [row(name)]).data),
      );
    for (const expression of [undefined, null, 42, "\ud800", "x".repeat(1001)])
      assert.throws(() =>
        normalizePickVarsData(pick(source, [{ ...row(), expression }]).data),
      );
    assert.throws(
      () => runNativeTaskPhase([pick(source)], { request: {} }),
      /后置/,
    );
    assert.equal(
      (await phase([pick(source, [row(" ")], 0)])).scopes.environment.old,
      "kept",
    );
  }
});

test("metadata reads current captured facade without body or public readers and preserves scalar types", async () => {
  for (const [source, key] of Object.entries(sources))
    for (const value of [null, false, 0, 3.25, "汉字", ""]) {
      const result = await phase([
        script(
          `const original=pm.response;original.${key}=${JSON.stringify(value)};Object.defineProperty(response,'body',{get(){throw Error('body read')},enumerable:true});pm.response={code:'forged',responseTime:'forged',responseSize:'forged'};pm.environment.set=()=>{throw Error('setter replaced')};`,
        ),
        pick(source, [
          row(" env "),
          row("global", "globalVars"),
          row("temporary", "tempVars"),
        ]),
      ]);
      assert.equal(result.scopes.environment.env, value);
      assert.equal(result.scopes.globals.global, value);
      assert.equal(result.localVariables.temporary, value);
    }
});

test("metadata rejects absent unsafe and oversized values without invoking accessors", async () => {
  for (const [source, key] of Object.entries(sources)) {
    for (const change of [
      `delete pm.response.${key}`,
      `pm.response.${key}=undefined`,
      `pm.response.${key}=NaN`,
      `pm.response.${key}=Infinity`,
      `pm.response.${key}=[]`,
      `pm.response.${key}={}`,
      `pm.response.${key}='汉'.repeat(22000)`,
      `pm.response.${key}='\\ud800'`,
      `Object.defineProperty(pm.response,'${key}',{enumerable:true,get(){throw Error('GETTER CALLED')}})`,
    ]) {
      await assert.rejects(
        () => phase([script(change), pick(source)]),
        (error) => {
          assert.match(error.message, /指标/);
          assert.doesNotMatch(error.message, /GETTER CALLED/);
          return true;
        },
      );
    }
  }
  const fresh = await phase([pick("responseCode")]);
  assert.equal(fresh.scopes.environment.picked, 200);
});

test("metadata snapshots once per task before setters and preserves trimmed name collisions", () => {
  const operations = compilePickVarsOperations([
    pick("responseTime", [
      row(" same "),
      row("same"),
      row("third", "globalVars"),
    ]).data,
  ]);
  const context = vm.createContext({ operations });
  vm.runInContext(
    `var writes=[];var facade={responseTime:7};var calls=0;var forbidden=()=>{calls++;throw Error('not used')};var setter=(name,value)=>{writes.push([name,value]);facade.responseTime=99};var state=(${pickVarsInstallerSource})(JSON.stringify(operations),forbidden,{},'{}',setter,setter,setter,forbidden,forbidden,facade);state.run(0);state.assertComplete();`,
    context,
  );
  assert.deepEqual(
    JSON.parse(vm.runInContext("JSON.stringify(writes)", context)),
    [
      ["same", 7],
      ["same", 7],
      ["third", 7],
    ],
  );
  assert.equal(context.calls, 0);
});
