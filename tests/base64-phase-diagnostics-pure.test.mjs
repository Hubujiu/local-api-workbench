import test from "node:test";
import assert, { AssertionError } from "node:assert/strict";
import { withWorkerPhaseDiagnostics } from "./helpers/worker-phase-diagnostics.mjs";

// Synthetic Errors only: importing a template implementation would start the
// QuickJS compilation path, so it is intentionally absent from this pure test.
const prefix = "\nWORKER_REJECTION_METADATA ";

test("Base64 positive watchdog diagnostics retain the failure and omit unavailable CPU observations", async () => {
  for (const observations of [
    {
      scriptStage: "total-deadline",
      lastWorkerStage: "starting",
      elapsedMs: 2005,
    },
    {},
  ]) {
    const original = Object.assign(Error("脚本执行超时"), observations);
    const before = Object.getOwnPropertyDescriptors(original);
    let calls = 0;
    await assert.rejects(
      withWorkerPhaseDiagnostics("base64-encode-empty", () => {
        calls++;
        return Promise.reject(original);
      }),
      (failure) => {
        assert.equal(failure, original);
        assert(
          failure.message.startsWith(
            "脚本执行超时\nWORKER_PHASE base64-encode-empty",
          ),
        );
        assert.deepEqual(
          JSON.parse(failure.message.split(prefix)[1]),
          observations,
        );
        const after = Object.getOwnPropertyDescriptors(failure);
        after.message.value = before.message.value;
        assert.deepEqual(after, before);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("Base64 quota matcher sees the original watchdog rejection before phase metadata is added", async () => {
  const original = Object.assign(Error("脚本执行超时"), {
    scriptStage: "total-deadline",
    lastWorkerStage: "loading-engine",
    elapsedMs: 2010,
  });
  const before = Object.getOwnPropertyDescriptors(original);
  const matcher = /64KiB/;
  let calls = 0;
  await assert.rejects(
    withWorkerPhaseDiagnostics("base64-oversized-before-length", (capture) => {
      calls++;
      return assert.rejects(Promise.reject(original).catch(capture), matcher);
    }),
    (failure) => {
      assert(failure instanceof AssertionError);
      assert.equal(failure.actual, original);
      assert.equal(failure.expected, matcher);
      assert.equal(failure.operator, "rejects");
      assert.equal(failure.code, "ERR_ASSERTION");
      assert(
        failure.message.includes(
          "\nWORKER_PHASE base64-oversized-before-length",
        ),
      );
      assert.deepEqual(JSON.parse(failure.message.split(prefix)[1]), {
        scriptStage: "total-deadline",
        lastWorkerStage: "loading-engine",
        elapsedMs: 2010,
      });
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(Object.getOwnPropertyDescriptors(original), before);
});
