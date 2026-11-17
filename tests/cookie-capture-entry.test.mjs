import test from "node:test";
import assert from "node:assert/strict";
import { observeCaptureEntry } from "./helpers/cookie-capture-entry.mjs";
function harness(execute) {
  const controller = new AbortController();
  const lifecycle = { captureEntered: false };
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  const observed = observeCaptureEntry({
    execute,
    controller,
    lifecycle,
    entered: { resolve },
  });
  return { controller, lifecycle, promise, observed };
}
test("early failure remains the exact rejection, signals entry wait, and blocks another dispatch", async () => {
  const error = Object.assign(new Error("original"), {
    code: "REQUEST_TIMEOUT",
  });
  let calls = 0;
  const h = harness(async () => {
    calls++;
    throw error;
  });
  await assert.rejects(h.observed(), (e) => e === error);
  await h.promise;
  assert.equal(h.controller.signal.aborted, true);
  assert.equal(h.lifecycle.firstErrorCode, "REQUEST_TIMEOUT");
  await assert.rejects(h.observed(), { code: "ABORT_ERR" });
  assert.equal(calls, 1);
});
test("capture reached keeps real result and does not add cancellation", async () => {
  const result = { status: 200 };
  const h = harness(async () => {
    h.lifecycle.captureEntered = true;
    return result;
  });
  assert.equal(await h.observed(), result);
  assert.equal(h.controller.signal.aborted, false);
});
test("failure after capture remains unchanged and does not add cancellation", async () => {
  const error = Object.assign(new Error("original"), {
    code: "REQUEST_TIMEOUT",
  });
  const h = harness(async () => {
    h.lifecycle.captureEntered = true;
    throw error;
  });
  await assert.rejects(h.observed(), (e) => e === error);
  assert.equal(h.controller.signal.aborted, false);
});
test("early returned response cannot allow subsequent transport or be mistaken for capture", async () => {
  const response = { status: 200 };
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return response;
  });
  assert.equal(await h.observed(), response);
  await h.promise;
  assert.equal(h.lifecycle.captureEntered, false);
  assert.equal(h.lifecycle.firstOutcome, "returned");
  await assert.rejects(h.observed(), { code: "ABORT_ERR" });
  assert.equal(calls, 1);
});
test("diagnostics never read error getters or replace proxy failures", async () => {
  let getter = 0;
  const error = Object.defineProperty(new Error("private"), "code", {
    get() {
      getter++;
      throw Error("no");
    },
  });
  const h = harness(async () => {
    throw error;
  });
  await assert.rejects(h.observed(), (e) => e === error);
  assert.equal(getter, 0);
  assert.equal(h.lifecycle.firstErrorCode, "OTHER");
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw Error("inspection");
      },
    },
  );
  const p = harness(async () => {
    throw proxy;
  });
  try {
    await p.observed();
    assert.fail("expected rejection");
  } catch (e) {
    assert.equal(e, proxy);
  }
  assert.equal(p.lifecycle.firstErrorCode, "OTHER");
});
