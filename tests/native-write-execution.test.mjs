import test from "node:test";
import assert from "node:assert/strict";
import {
  createNativeWriteExecution,
  assertNativeWritePlan,
  executeNativeWrite,
  finishNativeWrite,
} from "../src/native-write-execution.mjs";

// Pure capability ownership checks; no command is allowed to reach a socket.
function fixture() {
  const caller = new AbortController(),
    session = new AbortController(),
    authorization = new AbortController();
  const operation = {
    connectionId: "source",
    writeIntent: "redis-set",
    query: '["SET","k","v"]',
  };
  const plan = {
    steps: [
      {
        request: {
          nativeTasks: {
            before: [{ type: "database", enabled: 1, data: operation }],
            after: [],
          },
        },
      },
    ],
  };
  const handle = {
    snapshot: { plan },
    runId: "run",
    preparationId: "prep",
    projectId: "project",
    signal: authorization.signal,
    assertLive() {},
    consume() {
      assert.fail("cancelled operation must not consume");
    },
  };
  const target = {
    config: { type: "redis", host: "127.0.0.1", port: 1, database: "0" },
    signal: session.signal,
    assertLive() {},
  };
  return {
    caller,
    operation,
    plan,
    cap: createNativeWriteExecution(handle, target, { signal: caller.signal }),
  };
}
test("native capability admits exactly one unchanged plan and cannot resume after terminal not-sent", async () => {
  const { cap, plan, operation } = fixture();
  assert.throws(() =>
    assertNativeWritePlan(cap, { ...plan, name: "replacement" }),
  );
  assert.throws(() => executeNativeWrite(cap, operation, "before", 0));
  assertNativeWritePlan(cap, plan);
  assert.throws(() => assertNativeWritePlan(cap, plan));
  const receipt = await finishNativeWrite(cap);
  assert.equal(receipt[0].outcome, "not-sent");
  assert.throws(() => executeNativeWrite(cap, operation, "before", 0));
  assert.deepEqual(await finishNativeWrite(cap), receipt);
});
test("bound caller cancellation cannot be replaced with a fresh phase signal", async () => {
  const { cap, plan, operation, caller } = fixture();
  assertNativeWritePlan(cap, plan);
  caller.abort();
  await assert.rejects(
    executeNativeWrite(
      cap,
      operation,
      "before",
      0,
      new AbortController().signal,
    ),
    { code: "NATIVE_WRITE_STOPPED" },
  );
  const [receipt] = await finishNativeWrite(cap);
  assert.equal(receipt.outcome, "not-sent");
  assert.equal(receipt.reason, "cancelled");
});
test("caller cancelled before plan admission retains one terminal not-sent receipt", async () => {
  const { cap, plan, caller } = fixture();
  caller.abort();
  assert.throws(() => assertNativeWritePlan(cap, plan));
  assert.equal((await finishNativeWrite(cap))[0].reason, "cancelled");
});
