import test from "node:test";
import assert from "node:assert/strict";
import { runScript, runScriptSequence } from "../src/scripts.mjs";

const outputCode = 'pm.variables.set("payload", "x".repeat(900000));';
const input = () => ({
  variables: { retained: "original" },
  request: { url: "https://example.invalid/", method: "GET", headers: [] },
});

test("single-script completion never returns charged activity above its requested budget", async () => {
  for (const activityBudgetMs of [16, 20, 25, 32]) {
    for (let sample = 0; sample < 2; sample++) {
      const original = input();
      let result;
      try {
        result = await runScript(outputCode, original, { activityBudgetMs });
      } catch (error) {
        // Slow machines may exhaust the same budget before serialization.
        // No timeout is counted as evidence that any content validation passed.
        assert.match(error.message, /超时|interrupted/);
        assert.equal(error.scriptDiagnostics.activityBudgetMs, activityBudgetMs);
      }
      if (result) {
        assert.ok(
          result.activityMs <= activityBudgetMs,
          `returned ${result.activityMs}ms for ${activityBudgetMs}ms budget`,
        );
        assert.equal(result.localVariables.payload.length, 900000);
      }
      assert.deepEqual(original, input());
    }
  }
});

test("normal bounded serialization keeps data and fresh-script isolation", async () => {
  const original = input();
  const result = await runScript(outputCode, original);
  assert.equal(result.localVariables.payload.length, 900000);
  assert.equal(result.variables.retained, "original");
  assert.ok(result.activityMs <= 250);
  assert.deepEqual(original, input());
  const next = await runScript('pm.test("isolated",()=>pm.expect(pm.variables.get("payload")).to.equal(undefined));', original);
  assert.equal(next.tests[0].passed, true);
  assert.deepEqual(next.localVariables, {});
});

test("serialization size and invalid values still reject without committing state", async () => {
  for (const code of [
    'pm.variables.set("payload", "x".repeat(1048576));',
    'const a={}; a.self=a; pm.variables.set("payload",a);',
  ]) {
    const original = input();
    await assert.rejects(runScript(code, original), /输出超过|不可序列化|循环|circular/);
    assert.deepEqual(original, input());
  }
});

test("sequence terminal-budget rejection preserves input and later independent runs", async () => {
  const original = input();
  try {
    const result = await runScriptSequence([{ name: "request", code: outputCode }], original, { activityBudgetMs: 20 });
    assert.ok(result.activityMs <= 20);
    assert.equal(result.localVariables.payload.length, 900000);
  } catch (error) {
    assert.match(error.message, /超时|interrupted/);
  }
  assert.deepEqual(original, input());
  const next = await runScriptSequence([{ name: "request", code: 'pm.variables.set("ok","yes");' }], original);
  assert.equal(next.localVariables.ok, "yes");
});
