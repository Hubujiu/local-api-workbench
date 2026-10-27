import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { nativeRequestSnapshotSource } from "../src/native-request-snapshot.mjs";
const pick = (expression = "$", name = "value", type = "envVars") => ({
  type: "pickVars",
  enabled: 1,
  data: { source: "requestBody", variables: [{ name, type, expression }] },
});
const run = (body, tasks = [pick()], bodyType = "raw") =>
  runNativeTaskPhase(tasks, { request: { bodyType, body } });
test("request JSON5 snapshot accepts bounded grammar and keeps initial captured values", async () => {
  const body =
    "{/* [ ignored */ token:'原始', hex:0x10, plus:+2, leading:.5, trailing:2., text:'line\\\ncontinued', array:[true,null,], // } ignored\n}";
  const result = await run(body, [
    pick(),
    {
      type: "customScript",
      enabled: 1,
      data: "JSON5.parse=()=>({token:'forged'});pm.request.body.update('{}');",
    },
    pick("$.token", "again", "globalVars"),
    pick("$.hex", "number", "tempVars"),
  ]);
  assert.deepEqual(result.scopes.environment.value, {
    token: "原始",
    hex: 16,
    plus: 2,
    leading: 0.5,
    trailing: 2,
    text: "linecontinued",
    array: [true, null],
  });
  assert.equal(result.scopes.globals.again, "原始");
  assert.equal(result.localVariables.number, 16);
  assert.equal(result.request.body, "{}");
});
test("none and exact empty bodies snapshot as independent empty objects, not blank/comment documents", async () => {
  for (const [mode, body] of [
    ["none", undefined],
    ["raw", undefined],
    ["raw", ""],
    ["json", ""],
  ])
    assert.deepEqual(
      (await run(body, undefined, mode)).scopes.environment.value,
      {},
    );
  for (const body of [
    " ",
    "\n",
    "// comment",
    "/* comment */",
    "null",
    "42",
    "true",
    "'text'",
    "{a:NaN}",
    "{a:Infinity}",
    "{a:-Infinity}",
    "{a:1e999}",
    "{a:'\\ud800'}",
    "{__proto__:1}",
  ])
    await assert.rejects(async () => run(body));
  assert.deepEqual((await run('{"ok":1}')).scopes.environment.value, { ok: 1 });
});
test("request snapshot parser is not loaded for Header, none, empty, or excessive depth; errors remain source receipts", () => {
  for (const input of [
    { bodyType: "none" },
    { bodyType: "raw", body: "" },
    { headers: [] },
  ]) {
    const context = vm.createContext({ input });
    vm.runInContext(
      `var calls=0;var read=(${nativeRequestSnapshotSource})(input,[input.headers?'requestHeader':'requestBody'],()=>{calls++;throw Error('must not load')});`,
      context,
    );
    vm.runInContext(
      `read(input.headers?'requestHeader':'requestBody')`,
      context,
    );
    assert.equal(context.calls, 0);
  }
  const context = vm.createContext({
    input: { bodyType: "raw", body: "[".repeat(65) + "0" + "]".repeat(65) },
  });
  vm.runInContext(
    `var calls=0;var read=(${nativeRequestSnapshotSource})(input,['requestBody'],()=>{calls++;throw Error('must not load')});`,
    context,
  );
  assert.throws(() => vm.runInContext("read('requestBody')", context), /预检/);
  assert.equal(context.calls, 0);
});
test("JSON5 syntax errors remain deferred behind earlier tasks", async () => {
  await assert.rejects(
    () =>
      run("{bad:", [
        {
          type: "customScript",
          enabled: 1,
          data: 'throw Error("earlier task")',
        },
        pick(),
      ]),
    /earlier task/,
  );
});

test("JSON5 snapshot keeps UTF-8, structural and decoded-value limits", async () => {
  const value = "😀".repeat(100);
  assert.equal(
    (
      await run(
        `{value:'${value}', bracket:'${"[".repeat(70)}', /* ${"[".repeat(70)} */}`,
        [pick("$.value")],
      )
    ).scopes.environment.value,
    value,
  );
  assert.deepEqual(
    (
      await run("[".repeat(64) + "0" + "]".repeat(64), [
        pick("$" + "[0]".repeat(64)),
      ])
    ).scopes.environment.value,
    0,
  );
  for (const body of [
    '{value:"' + "a".repeat(65536) + '"}',
    '{value:"\ud800"}',
    "[" + "0,".repeat(10000) + "0]",
  ])
    await assert.rejects(async () => run(body));
  // Disabled declarations do not instantiate or validate their unsupported source.
  const disabled = pick();
  disabled.enabled = 0;
  await assert.doesNotReject(async () => run("not JSON5", [disabled]));
});
