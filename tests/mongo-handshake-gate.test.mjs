import test from "node:test";
import assert from "node:assert/strict";
import { mongoHandshakeGate } from "./helpers/mongo-handshake-gate.mjs";
import { observeToolCall } from "./helpers/mcp-cancellation-observation.mjs";

const pending = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { observation: observeToolCall(promise), resolve };
};
test("first data aborts synchronously, without a polling turn; old epoch cannot abort the next", async () => {
  const first = new AbortController(),
    next = new AbortController();
  const one = mongoHandshakeGate(first),
    two = mongoHandshakeGate(next);
  one.attach(pending().observation);
  two.attach(pending().observation);
  try {
    one.accepted();
    one.data();
    assert.equal(first.signal.aborted, true);
    assert.equal(next.signal.aborted, false);
    await one.ready;
    one.dispose();
    one.data();
    one.closed();
    assert.equal(next.signal.aborted, false);
    two.data();
    assert.equal(next.signal.aborted, true);
    await two.ready;
  } finally {
    one.dispose();
    two.dispose();
  }
});
test("terminal before data is failure, never successful cancellation", async () => {
  const controller = new AbortController();
  const gate = mongoHandshakeGate(controller);
  const call = pending();
  gate.attach(call.observation);
  const rejected = assert.rejects(
    gate.ready,
    /terminated before fixture handshake/,
  );
  call.resolve({ secret: "must-not-be-logged" });
  await rejected;
  gate.data();
  assert.equal(controller.signal.aborted, false);
  gate.dispose();
  const times = JSON.parse(
    gate.diagnostic().slice("MONGO_FIXTURE_TIMING ".length),
  );
  assert.deepEqual(Object.keys(times), ["call", "terminal"]);
  for (const value of Object.values(times))
    assert(Number.isSafeInteger(value) && value >= 0);
  assert(!gate.diagnostic().includes("must-not-be-logged"));
});
test("pending assertion is preserved at the data event", async () => {
  const controller = new AbortController();
  const gate = mongoHandshakeGate(controller);
  const observation = observeToolCall(Promise.resolve({}));
  await observation.completion;
  gate.attach(observation);
  gate.data();
  await assert.rejects(gate.ready, /terminated before fixture abort/);
  assert.equal(controller.signal.aborted, false);
  gate.dispose();
});
test("deadline control observes real data without cancelling", async () => {
  const controller = new AbortController();
  const gate = mongoHandshakeGate(controller, { cancel: false });
  const call = pending();
  gate.attach(call.observation);
  gate.accepted();
  gate.data();
  await gate.ready;
  call.resolve({ status: "failed" });
  await call.observation.completion;
  gate.closed();
  assert.equal(controller.signal.aborted, false);
  const times = JSON.parse(
    gate.diagnostic().slice("MONGO_FIXTURE_TIMING ".length),
  );
  assert.deepEqual(Object.keys(times), [
    "call",
    "accept",
    "data",
    "terminal",
    "close",
  ]);
  gate.dispose();
});
test("unchanged five-second readiness timeout fails and never aborts as success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const gate = mongoHandshakeGate(controller);
  gate.attach(pending().observation);
  const rejected = assert.rejects(gate.ready, /observation did not arrive/);
  t.mock.timers.tick(4999);
  gate.accepted();
  assert.equal(controller.signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  gate.data();
  assert.equal(controller.signal.aborted, false);
  gate.dispose();
});
