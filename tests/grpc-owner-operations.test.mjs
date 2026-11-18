import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GrpcOwnerOperations } from "../src/grpc-owner-operations.mjs";
function harness() {
  const session = {},
    callbacks = [];
  let effects = 0;
  const sessions = {
    get(p, id) {
      assert.equal(p, "p");
      assert.equal(id, "s");
      return session;
    },
    snapshot() {
      return { id: "s" };
    },
    send(p, id, m, o) {
      o.onSubmitted();
      effects++;
      callbacks.push(o.onComplete);
    },
    halfClose(p, id, o) {
      o.onSubmitted();
      effects++;
      callbacks.push(o.onComplete);
    },
  };
  const ledger = new GrpcOwnerOperations(sessions);
  const correlation = (seq) => ({
    instanceId: ledger.instanceId,
    operationId: seq + ":" + randomUUID(),
  });
  return { sessions, ledger, callbacks, correlation, effects: () => effects };
}
test("owner receipts distinguish pending/local completion/unknown and never reexecute", () => {
  const { ledger, correlation, callbacks, effects } = harness();
  const op = correlation(1);
  ledger.execute("p", "s", "send", { secret: "only transport" }, op);
  assert.equal(
    ledger.snapshot("p", "s").ownerOperations.receipts[0].state,
    "pending",
  );
  callbacks[0]({ state: "unknown" });
  callbacks[0]({ state: "locally-written" });
  assert.equal(
    ledger.snapshot("p", "s").ownerOperations.receipts[0].state,
    "unknown",
  );
  assert.throws(() => ledger.execute("p", "s", "send", {}, op));
  assert.throws(() => ledger.execute("p", "s", "send", {}, correlation(1)));
  assert.throws(() => ledger.execute("p", "s", "send", {}, correlation(3)));
  assert.equal(effects(), 1);
  assert.equal(
    JSON.stringify(ledger.snapshot("p", "s")).includes("secret"),
    false,
  );
});
test("bounded retention continues beyond 256 attempts with retired IDs fail closed", () => {
  const { ledger, correlation, sessions, effects } = harness();
  sessions.send = () => {
    throw Error("preflight");
  };
  const first = correlation(1);
  for (let i = 1; i <= 1000; i++)
    assert.throws(() =>
      ledger.execute("p", "s", "send", {}, i === 1 ? first : correlation(i)),
    );
  const view = ledger.snapshot("p", "s").ownerOperations;
  assert.equal(view.sequence, 1000);
  assert.equal(view.receipts.length, 128);
  assert.equal(view.receipts[0].state, "failed-before-submit");
  assert.throws(() => ledger.execute("p", "s", "send", {}, first));
  assert.equal(effects(), 0);
});
test("foreign project, instance and unsafe sequence cannot submit", () => {
  const { ledger, correlation, effects } = harness();
  const op = correlation(1);
  assert.throws(() => ledger.execute("foreign", "s", "send", {}, op));
  assert.throws(() =>
    ledger.execute("p", "s", "send", {}, { ...op, instanceId: "old" }),
  );
  for (const seq of ["01", "0", "1e0", "9007199254740992"])
    assert.throws(() =>
      ledger.execute(
        "p",
        "s",
        "send",
        {},
        { ...op, operationId: seq + ":" + randomUUID() },
      ),
    );
  assert.equal(effects(), 0);
});
