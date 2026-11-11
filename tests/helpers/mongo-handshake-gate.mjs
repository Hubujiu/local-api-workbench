// Test-only, per invocation: the socket listener closes over this gate, never a
// mutable "current call" slot. Only fixed event names and monotonic elapsed
// times are retained; no addresses, payloads, errors or MCP identifiers.
export function mongoHandshakeGate(controller, { cancel = true } = {}) {
  const zero = performance.now();
  const times = Object.create(null);
  const mark = (event) => {
    if (!(event in times))
      times[event] = Math.max(0, Math.round(performance.now() - zero));
  };
  let observation,
    settled = false,
    resolve,
    reject;
  const ready = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let timer;
  function fail(error) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  }
  return {
    ready,
    attach(value) {
      observation = value;
      mark("call");
      timer = setTimeout(
        () => fail(Error("Mongo SDK cancellation observation did not arrive")),
        5000,
      );
      observation.completion.then(() => {
        mark("terminal");
        if (!settled)
          fail(Error("MCP tool call terminated before fixture handshake"));
      });
    },
    accepted() {
      mark("accept");
    },
    data() {
      if (settled) return;
      mark("data");
      try {
        observation.assertPending();
        if (cancel) {
          mark("abort");
          controller.abort();
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      } catch (error) {
        fail(error);
      }
    },
    closed() {
      mark("close");
    },
    dispose() {
      clearTimeout(timer);
      settled = true;
    },
    diagnostic() {
      return "MONGO_FIXTURE_TIMING " + JSON.stringify(times);
    },
  };
}
