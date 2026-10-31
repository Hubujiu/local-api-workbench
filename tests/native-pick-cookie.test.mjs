import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import { executeRequest } from "../src/runtime.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import {
  normalizePickVarsData,
  compilePickVarsOperations,
  pickVarsInstallerSource,
} from "../src/native-response-extraction.mjs";
const row = (name = "picked", expression = " Session ", type = "envVars") => ({
  name,
  expression,
  type,
});
const pick = (variables = [row()], enabled = 1) => ({
  type: "pickVars",
  enabled,
  data: { source: "responseCookie", variables },
});
const script = (data) => ({ type: "customScript", enabled: 1, data });
async function fixture(t, lines = ["Session=one"]) {
  const server = http.createServer((_q, r) => {
    r.setHeader("set-cookie", lines);
    r.setHeader("x-proof", "ok");
    r.end("not JSON");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return () =>
    executeRequest({ url: `http://127.0.0.1:${server.address().port}` });
}
const phase = (response, tasks) =>
  runNativeTaskPhase(tasks, {
    request: {},
    response,
    scopes: { environment: { old: "kept" }, globals: {}, runtime: {} },
  });
test("Cookie pick trims only expression, preserves raw target, disabled inert and post-only", async () => {
  const data = pick([row(" target ")]).data;
  assert.deepEqual(normalizePickVarsData(data), data);
  assert.deepEqual(compilePickVarsOperations([data])[0].variables, [
    { name: " target ", cookie: "Session", scope: "environment" },
  ]);
  for (const name of [
    "",
    "a.b",
    "a[b]",
    "constructor",
    "__proto__",
    "toString",
    "{{x}}",
  ])
    assert.throws(() => normalizePickVarsData(pick([row("x", name)]).data));
  assert.throws(() => runNativeTaskPhase([pick()], { request: {} }), /后置/);
  assert.equal(
    (await phase(undefined, [pick([row(" ", "{{x}}")], 0)])).scopes.environment
      .old,
    "kept",
  );
});
test("Cookie current captured map survives public replacement without invoking body or methods", async (t) => {
  const read = await fixture(t, [
    "Session=A=B==",
    "session=%E4%B8%AD",
    "bad=%ZZ",
    "space=%20x%20",
  ]);
  const result = await phase(await read(), [
    pick([row("initial")]),
    script(
      "const original=response.cookies;original.Session='edited';response.cookies={Session:'forged'};pm.cookies.get=()=>{throw Error('reader')};pm.environment.set=()=>{throw Error('setter')};Object.defineProperty(response,'body',{enumerable:true,get(){throw Error('body')}});",
    ),
    pick([
      row(" target "),
      row("g", "session", "globalVars"),
      row("temp", "bad", "tempVars"),
      row("space", "space"),
    ]),
  ]);
  assert.equal(result.scopes.environment.initial, "A=B==");
  assert.equal(result.scopes.environment[" target "], "edited");
  assert.equal(result.scopes.globals.g, "中");
  assert.equal(result.localVariables.temp, "%ZZ");
  assert.equal(result.scopes.environment.space, " x ");
  assert.equal(
    (
      await phase(await read(), [
        script("response.cookies.Session='';"),
        pick(),
      ])
    ).scopes.environment.picked,
    "",
  );
  assert.equal(
    (await phase(await read(), [pick()])).scopes.environment.picked,
    "A=B==",
  );
});
test("Cookie missing deleted unsafe and unproven current fields reject without getters", async (t) => {
  const read = await fixture(t);
  for (const change of [
    "delete response.cookies.Session",
    "response.cookies.Session=undefined",
    "response.cookies.Session=42",
    "response.cookies.Session={}",
    "response.cookies.Session='汉'.repeat(22000)",
    "response.cookies.Session='\\ud800'",
    "Object.defineProperty(response.cookies,'Session',{enumerable:true,get(){throw Error('GETTER CALLED')}})",
  ]) {
    await assert.rejects(
      () => phaseResponse(change),
      (e) => {
        assert.match(e.message, /Cookie/);
        assert.doesNotMatch(e.message, /GETTER CALLED/);
        return true;
      },
    );
  }
  async function phaseResponse(change) {
    return phase(await read(), [script(change), pick()]);
  }
  await assert.rejects(
    async () =>
      phase(await read(), [
        script("response.cookies.new='invented'"),
        pick([row("x", "new")]),
      ]),
    /传输证据/,
  );
  const actual = await read();
  await assert.rejects(
    () => phase(structuredClone(actual), [pick()]),
    /传输证据/,
  );
});
test("Cookie ambiguous transport fails but Header remains usable on same real response", async (t) => {
  for (const lines of [
    ["Session=one", "Session=two"],
    ["Session=one", "a.b=x"],
    ["Session=one", "bad="],
    ["Session=one", "bad=x ; Path=/"],
  ]) {
    const read = await fixture(t, lines);
    await assert.rejects(async () => phase(await read(), [pick()]), /传输证据/);
    const result = await phase(await read(), [
      {
        type: "pickVars",
        enabled: 1,
        data: {
          source: "responseHeader",
          variables: [row("proof", "x-proof")],
        },
      },
    ]);
    assert.equal(result.scopes.environment.proof, "ok");
  }
});
test("Cookie all rows prepare before writes and task boundaries retain map reference not deep copy", () => {
  const operations = compilePickVarsOperations([
    pick([row("a"), row("b")]).data,
    pick([row("later")]).data,
  ]);
  const context = vm.createContext({ operations });
  vm.runInContext(
    `var writes=[];var cookies={Session:'initial'};var setter=(k,v)=>{writes.push([k,v]);cookies.Session='changed'};var forbidden=()=>{throw Error('other source read')};var state=(${pickVarsInstallerSource})(JSON.stringify(operations),forbidden,{},'{}',setter,setter,setter,forbidden,forbidden,{},null,cookies,JSON.stringify({complete:true,values:{Session:'initial'}}));state.run(0);state.run(1);state.assertComplete();`,
    context,
  );
  assert.deepEqual(
    JSON.parse(vm.runInContext("JSON.stringify(writes)", context)),
    [
      ["a", "initial"],
      ["b", "initial"],
      ["later", "changed"],
    ],
  );
  const bad = compilePickVarsOperations([
    pick([row("a"), row("b", "missing")]).data,
  ]);
  context.operations = bad;
  vm.runInContext(
    `writes=[];cookies={Session:'initial'};state=(${pickVarsInstallerSource})(JSON.stringify(operations),forbidden,{},'{}',setter,setter,setter,forbidden,forbidden,{},null,cookies,JSON.stringify({complete:true,values:{Session:'initial'}}));`,
    context,
  );
  assert.throws(() => vm.runInContext("state.run(0)", context), /Cookie/);
  assert.equal(context.writes.length, 0);
  assert.throws(
    () => vm.runInContext("state.assertComplete()", context),
    /未完成/,
  );
});

test("Cookie bootstrap projection mismatch fails even if scripts later repair it", () => {
  const operations = compilePickVarsOperations([pick().data]);
  for (const initial of [
    "{Session:'different'}",
    "{}",
    "{Session:'one',extra:'x'}",
    "Object.defineProperty({},'Session',{enumerable:true,get(){throw Error('GETTER CALLED')}})",
  ]) {
    const context = vm.createContext({ operations });
    vm.runInContext(
      `var writes=[];var cookies=${initial};var setter=(k,v)=>writes.push([k,v]);var forbidden=()=>{throw Error('other source read')};var state=(${pickVarsInstallerSource})(JSON.stringify(operations),forbidden,{},'{}',setter,setter,setter,forbidden,forbidden,{},null,cookies,JSON.stringify({complete:true,values:{Session:'one'}}));`,
      context,
    );
    assert.throws(
      () => vm.runInContext("state.run(0)", context),
      (e) => {
        assert.match(e.message, /传输证据/);
        assert.doesNotMatch(e.message, /GETTER CALLED/);
        return true;
      },
    );
    assert.equal(context.writes.length, 0);
  }
});
