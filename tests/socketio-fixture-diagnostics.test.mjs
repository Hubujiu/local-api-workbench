import test from "node:test";
import assert from "node:assert/strict";
import { socketIOFixtureDiagnostics } from "./helpers/socketio-fixture-diagnostics.mjs";
function setup() {
  const controller = new AbortController(),
    output = [];
  const secret = "PRIVATE_SOCKETIO_PAYLOAD_998";
  const fixture = {
    handshakes: [secret],
    received: [{ inputs: [secret], serverAcks: [], id: secret }],
    consumed: [{ token: secret }],
    active: new Set([secret]),
    engineClients: 1,
  };
  const diagnostic = socketIOFixtureDiagnostics(
    { signal: controller.signal, diagnostic: (s) => output.push(s) },
    fixture,
  );
  return { controller, output, fixture, diagnostic, secret };
}
test("Socket.IO diagnostic success is silent and disposed abort stays silent", () => {
  const f = setup();
  f.diagnostic.dispose();
  f.controller.abort();
  assert.deepEqual(f.output, []);
});
test("Socket.IO diagnostic failure and abort report once, fixed bounded metadata only", () => {
  const f = setup();
  f.fixture.engineClients = 999999999;
  f.fixture.received[0].serverAcks = { length: -1 };
  f.diagnostic.state.runInvoked = true;
  f.diagnostic.state.runRejected = f.secret;
  f.diagnostic.state.payload = f.secret;
  f.diagnostic.report();
  f.controller.abort();
  f.diagnostic.report();
  assert.equal(f.output.length, 1);
  assert.ok(!f.output[0].includes(f.secret));
  const data = JSON.parse(
    f.output[0].slice("SOCKETIO_REPEAT_LIFECYCLE ".length),
  );
  assert.deepEqual(data, {
    handshakes: 1,
    connections: 1,
    firstInputs: 1,
    secondInputs: 0,
    firstServerAcks: 0,
    secondServerAcks: 0,
    consumed: 1,
    active: 1,
    engineClients: 1000000,
    runInvoked: true,
    runSettled: false,
    runRejected: false,
    secondInputObserved: false,
    cancelRequested: false,
    cancelAccepted: false,
    runAwaited: false,
    lateAckInvoked: false,
    nextRunInvoked: false,
  });
  assert.ok(f.output[0].length < 1024);
});
test("Socket.IO abort takes immediate snapshot before cleanup", () => {
  const f = setup();
  f.controller.abort();
  f.fixture.active.clear();
  f.diagnostic.report();
  assert.equal(f.output.length, 1);
  assert.match(f.output[0], /"active":1/);
});
