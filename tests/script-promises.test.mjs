import test from "node:test";
import assert from "node:assert/strict";
import { runScript } from "../src/scripts.mjs";
test("top-level await and async assertions settle before script output", async () => {
  const result = await runScript(
    `await Promise.resolve();apt.setVar('awaited',true);pm.test('async pass',async()=>{await new Promise(resolve=>setTimeout(resolve,5));pm.expect(2).to.equal(2)});pm.test('async fail',async()=>{await 1;throw Error('assertion failure')});`,
    { variables: {} },
  );
  assert.equal(result.variables.awaited, true);
  assert.equal(result.tests[0].passed, true);
  assert.equal(result.tests[1].passed, false);
  assert.match(result.tests[1].error, /assertion failure/);
});
test("detached rejected promises fail while handled rejections do not", async () => {
  for (const code of [
    "Promise.reject(Error('detached'))",
    "(async()=>{await 1;throw Error('detached')})()",
    "await Promise.reject(Error('detached'))",
  ])
    await assert.rejects(runScript(code, { variables: {} }), /detached/);
  const result = await runScript(
    "await Promise.reject(Error('handled')).catch(()=>apt.setVar('caught',true))",
    { variables: {} },
  );
  assert.equal(result.variables.caught, true);
});
test("unresolved root and runaway microtasks cannot report success", async () => {
  await assert.rejects(
    runScript("await new Promise(()=>{})", { variables: {} }),
    /未完成|超时|终止/,
  );
  await assert.rejects(
    runScript("function spin(){Promise.resolve().then(spin)}spin()", {
      variables: {},
    }),
    /微任务|超时|interrupt|终止/,
  );
});
test("async timer callbacks settle and unresolved callbacks fail", async () => {
  const result = await runScript(
    'setTimeout(async()=>{await new Promise(resolve=>setTimeout(resolve,5));apt.setVar("timer",true)},0)',
    { variables: {} },
  );
  assert.equal(result.variables.timer, true);
  await assert.rejects(
    runScript("setTimeout(()=>new Promise(()=>{}),0)", { variables: {} }),
    /Promise未完成/,
  );
});
test("pure function previews await returned values without granting network authority", async () => {
  const { previewFunction } = await import("../src/custom-functions.mjs");
  assert.equal(
    (
      await previewFunction(
        { name: "promise", body: "return Promise.resolve(args[0]+1)" },
        2,
      )
    ).value,
    3,
  );
  await assert.rejects(
    previewFunction(
      { name: "bad", body: 'return Promise.reject(Error("preview rejected"))' },
      2,
    ),
    /preview rejected/,
  );
  await assert.rejects(
    previewFunction(
      {
        name: "network",
        body: 'return pm.sendRequest("https://example.test")',
      },
      2,
    ),
    /网络/,
  );
});
test("microtasks drain between individual timer callbacks", async () => {
  const result = await runScript(
    'const order=[];setTimeout(()=>{order.push(1);Promise.resolve().then(()=>order.push(2))},0);setTimeout(()=>{order.push(3);apt.setVar("order",order)},0)',
    { variables: {} },
  );
  assert.deepEqual(result.variables.order, [1, 2, 3]);
});
test("output serialization cannot hide late rejected promises or schedule more work", async () => {
  for (const body of [
    "Promise.reject(Error('late rejection'));return 1",
    "Promise.resolve().then(()=>{throw Error('late rejection')});return 1",
    "setTimeout(()=>{},0);return 1",
  ]) {
    await assert.rejects(
      runScript(`pm.variables.set('late',{toJSON(){${body}}})`, {
        variables: {},
      }),
      /序列化|异步|拒绝|late rejection/,
    );
  }
});
