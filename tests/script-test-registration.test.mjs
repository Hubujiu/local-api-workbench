import test from "node:test";
import assert from "node:assert/strict";
import { runScript, runScriptSequence } from "../src/scripts.mjs";
import { runPlan, snapshotPlan } from "../src/core.mjs";

test("skip records an explicit non-executed assertion and index follows registration including async tests", async () => {
  const result = await runScript(
    `
    const indices=[pm.test.index()];
    if(pm.test.skip('deferred',()=>{throw Error('must not run')})!==pm)throw Error('chain');
    indices.push(apt.test.index());
    pm.test('async', done=>{indices.push(pm.test.index());setTimeout(()=>{indices.push(pm.test.index());done()},1)});
    await new Promise(resolve=>setTimeout(resolve,5));
    apt.setVar('indices',indices);
  `,
    { variables: {} },
  );
  assert.deepEqual(result.variables.indices, [0, 1, 2, 2]);
  assert.deepEqual(result.tests[0], {
    name: "deferred",
    passed: true,
    skipped: true,
  });
  assert.equal(result.tests[1].passed, true);
  const next = await runScript("apt.setVar('index',pm.test.index())", {
    variables: {},
  });
  assert.equal(next.variables.index, 0);
});
test("skipped assertions consume the same per-sequence assertion budget", async () => {
  await assert.rejects(
    runScriptSequence(
      [
        { name: "first", code: "for(let i=0;i<600;i++)pm.test.skip('one');" },
        { name: "second", code: "for(let i=0;i<600;i++)pm.test.skip('two');" },
      ],
      { variables: {} },
    ),
    /最多1000条/,
  );
});
test("skipping cannot hide a real assertion failure or HTTP error", async () => {
  for (const [status, afterScript] of [
    [500, "pm.test.skip('not checked');"],
    [
      200,
      "pm.test.skip('not checked');pm.test('real failure',()=>{throw Error('bad')});",
    ],
  ]) {
    const plan = snapshotPlan({
      steps: [
        {
          request: {
            url: "http://localhost",
            beforeScript: "pm.test.skip('pre');",
            afterScript,
          },
        },
      ],
    });
    const result = await runPlan(plan, {}, async () => ({
      status,
      body: "{}",
      headers: {},
    }));
    assert.equal(result.status, "failed");
    assert.equal(result.results[0].assertions[0].skipped, true);
    assert(result.results[0].response);
  }
});
