import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  MSI_OPERATION_TIMEOUT_MS,
  waitForMsiExit,
} from "./helpers/msi-process-deadline.mjs";
function child() {
  const value = new EventEmitter();
  value.unrefs = 0;
  value.unref = () => value.unrefs++;
  value.kill = () => assert.fail("Never terminate uncertain MSI state");
  return value;
}
test("full product deadline is fixed and bounded at seven minutes", () =>
  assert.equal(MSI_OPERATION_TIMEOUT_MS, 420000));
test("successful exit returns exact exit status and removes listeners", async () => {
  const c = child(),
    result = waitForMsiExit(c, "upgrade", 1000);
  c.emit("exit", 0, null);
  assert.deepEqual(await result, [0, null]);
  assert.equal(c.unrefs, 0);
  assert.equal(c.listenerCount("exit"), 0);
  assert.equal(c.listenerCount("error"), 0);
});
test("nonzero exit never becomes timeout or success", async () => {
  const c = child(),
    result = waitForMsiExit(c, "uninstall", 1000);
  c.emit("exit", 1603, null);
  assert.deepEqual(await result, [1603, null]);
  assert.equal(c.unrefs, 0);
});
test("spawn error rejects without retry or hanging timer", async () => {
  const c = child(),
    result = waitForMsiExit(c, "reinstall", 1000);
  c.emit("error", new Error("spawn failed"));
  await assert.rejects(result, /spawn failed/);
  assert.equal(c.listenerCount("exit"), 0);
});
test("timeout preserves unknown service state, no kill/retry/cleanup", async () => {
  const c = child();
  const result = waitForMsiExit(c, "upgrade", 10);
  await assert.rejects(result, {
    code: "MSI_TIMEOUT",
    message:
      /MSI upgrade timeout after 10 ms: service state uncertain; do not retry or clean up/,
  });
  assert.equal(c.unrefs, 1);
  assert.equal(c.listenerCount("exit"), 0);
  c.emit("exit", 0, null);
  assert.equal(c.unrefs, 1);
});
