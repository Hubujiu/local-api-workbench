// Test-only, bounded metadata. Never serialize fixture rows or execution results.
export function socketIOFixtureDiagnostics(t, fixture) {
  const state = {
    runInvoked: false,
    runSettled: false,
    runRejected: false,
    secondInputObserved: false,
    cancelRequested: false,
    cancelAccepted: false,
    runAwaited: false,
    lateAckInvoked: false,
    nextRunInvoked: false,
  };
  let reported = false;
  const count = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1000000) : 0;
  const report = () => {
    if (reported) return;
    reported = true;
    t.diagnostic(
      `SOCKETIO_REPEAT_LIFECYCLE ${JSON.stringify({
        handshakes: count(fixture.handshakes.length),
        connections: count(fixture.received.length),
        firstInputs: count(fixture.received[0]?.inputs.length),
        secondInputs: count(fixture.received[1]?.inputs.length),
        firstServerAcks: count(fixture.received[0]?.serverAcks.length),
        secondServerAcks: count(fixture.received[1]?.serverAcks.length),
        consumed: count(fixture.consumed.length),
        active: count(fixture.active.size),
        engineClients: count(fixture.engineClients),
        runInvoked: state.runInvoked === true,
        runSettled: state.runSettled === true,
        runRejected: state.runRejected === true,
        secondInputObserved: state.secondInputObserved === true,
        cancelRequested: state.cancelRequested === true,
        cancelAccepted: state.cancelAccepted === true,
        runAwaited: state.runAwaited === true,
        lateAckInvoked: state.lateAckInvoked === true,
        nextRunInvoked: state.nextRunInvoked === true,
      })}`,
    );
  };
  t.signal.addEventListener("abort", report, { once: true });
  return {
    state,
    report,
    dispose() {
      t.signal.removeEventListener("abort", report);
    },
  };
}
