import test from "node:test";
import assert from "node:assert/strict";
import { runScript, runScriptSequence } from "../src/scripts.mjs";
function metrics(value) {
  assert.equal(typeof value, "object");
  assert.ok(value && !Array.isArray(value));
  for (const [key, amount] of Object.entries(value)) {
    assert.ok(key.endsWith("Us"));
    assert.ok(Number.isFinite(amount) && amount >= 0);
  }
  if (typeof process.threadCpuUsage === "function") {
    assert.ok(Object.hasOwn(value, "compatibilityUs"));
    assert.ok(Object.hasOwn(value, "userScriptUs"));
  }
}
test("script CPU diagnostics accompany success without exposing host process APIs", async () => {
  const result = await runScript(
    'apt.setVar("host",typeof process);apt.setVar("value",7);',
    {},
  );
  assert.equal(result.variables.host, "undefined");
  assert.equal(result.variables.value, 7);
  metrics(result.activityCPUTimeUs);
  assert.ok(Number.isFinite(result.activityMetrics.compatibilityMs));
});
test("script CPU diagnostics survive worker errors and completed sequence stages", async () => {
  await assert.rejects(
    runScript('throw Error("cpu-diagnostic-error")', {}),
    (error) => {
      assert.equal(error.message, "脚本Promise被拒绝: cpu-diagnostic-error");
      metrics(error.activityCPUTimeUs);
      return true;
    },
  );
  await assert.rejects(
    runScriptSequence(
      [
        { name: "first", code: 'apt.setVar("value",1)' },
        { name: "second", code: 'throw Error("cpu-sequence-error")' },
      ],
      {},
    ),
    (error) => {
      assert.equal(error.message, "脚本Promise被拒绝: cpu-sequence-error");
      assert.equal(error.scriptScope, "second");
      metrics(error.activityCPUTimeUs);
      assert.equal(error.sequenceActivity.length, 1);
      metrics(error.sequenceActivity[0].activityCPUTimeUs);
      return true;
    },
  );
});
