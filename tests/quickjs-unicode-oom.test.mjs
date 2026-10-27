import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { compileTrackedQuickJS } from "../src/tracked-quickjs.mjs";

const compiled = await compileTrackedQuickJS();
function boundedWorker(pattern) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./fixtures/quickjs-unicode-oom-worker.mjs", import.meta.url),
      {
        workerData: { pattern, compiled },
        resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
      },
    );
    let settled = false;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    // Failure protection only: wall termination is never a passing OOM result.
    const timer = setTimeout(
      () =>
        finish(Error("Unicode OOM worker exceeded unchanged 2s wall guard")),
      2000,
    );
    worker.once("error", (error) => finish(error));
    worker.once("message", (result) => finish(undefined, result));
    worker.once("exit", (code) => {
      if (!settled)
        finish(Error("Unicode OOM worker exited without evidence: " + code));
    });
  });
}

for (const pattern of ["\\p{Script=Common}", "\\p{Script_Extensions=Common}"]) {
  test(`Unicode compile OOM returns and restores the same allocator baseline: ${pattern}`, async () => {
    const result = await boundedWorker(pattern);
    const evidence = JSON.stringify(result);
    assert.equal(result.warm.error, false, evidence);
    assert.deepEqual(result.warm.value, [1024 * 1024, true]);
    assert.equal(result.rounds.length, 2, evidence);
    for (const round of result.rounds) {
      assert.equal(round.result.error, false, evidence);
      // Existing compile OOM classification is SyntaxError, not match-time OOM
      // InternalError or an interruption. This backport does not change it.
      assert.deepEqual(round.result.value, [
        "SyntaxError",
        "out of memory",
        round.fillBytes,
      ]);
      assert.deepEqual(round.afterFailure, round.before, evidence);
      assert.equal(round.recovery.error, false, evidence);
      assert.deepEqual(round.recovery.value, [1024 * 1024, true]);
      assert.deepEqual(round.afterRecovery, round.before, evidence);
    }
    assert.equal(result.phase, "released", evidence);
    assert.equal(result.expiredChecks, 0, evidence);
    assert(result.elapsedMs < 250, evidence);
    assert.equal(result.unhandledAfterDispose, 0, evidence);
  });
}
