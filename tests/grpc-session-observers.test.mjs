import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { GrpcSessions } from "../src/grpc-sessions.mjs";

function fixture(t, { ready = true, failSave = false } = {}) {
  let attempts = 0;
  const call = new EventEmitter();
  Object.assign(call, {
    writes: 0,
    ends: 0,
    write(_message, callback) {
      this.writes++;
      this.callback = callback;
      return ready;
    },
    end(callback) {
      this.ends++;
      this.endCallback = callback;
    },
    cancel() {},
  });
  const sessions = new GrpcSessions({
    store: {
      async get() {
        attempts++;
        if (failSave) throw Error("controlled storage failure");
        return { protocolRuns: [] };
      },
      async append() {},
    },
    createClient: () => ({ makeBidiStreamRequest: () => call, close() {} }),
  });
  const { id } = sessions.start("p", {
    id: "d",
    name: "observer",
    target: "grpc://127.0.0.1:1",
    proto:
      'syntax = "proto3"; package observer; message Value { string text = 1; } service Echo { rpc Chat(stream Value) returns(stream Value); }',
    service: "observer.Echo",
    method: "Chat",
    timeoutMs: 30000,
  });
  t.after(() => sessions.close());
  return {
    sessions,
    call,
    id,
    get attempts() {
      return attempts;
    },
  };
}

for (const order of ["callback-first", "drain-first"]) {
  test(`gRPC send observer waits for callback and drain: ${order}`, (t) => {
    const { sessions, call, id } = fixture(t, { ready: false });
    const submitted = [],
      completed = [];
    sessions.send(
      "p",
      id,
      { text: "one" },
      {
        onSubmitted: (value) => submitted.push(value),
        onComplete: (value) => completed.push(value),
      },
    );
    assert.deepEqual(submitted, [{ messageIndex: 1 }]);
    if (order === "callback-first") call.callback();
    else call.emit("drain");
    assert.deepEqual(completed, []);
    assert.throws(() => sessions.send("p", id, { text: "two" }), /等待/);
    assert.throws(() => sessions.halfClose("p", id), /未完成/);
    if (order === "callback-first") call.emit("drain");
    else call.callback();
    assert.deepEqual(completed, [
      { state: "locally-written", messageIndex: 1 },
    ]);
    call.callback();
    call.emit("drain");
    assert.equal(completed.length, 1);
    assert.equal(call.writes, 1);
  });
}

test("gRPC submitted send becomes unknown once at cancel, late callback cannot revise evidence", async (t) => {
  const { sessions, call, id } = fixture(t, { ready: false });
  const completed = [];
  sessions.send(
    "p",
    id,
    { text: "one" },
    { onComplete: (value) => completed.push(value) },
  );
  await sessions.cancel("p", id, { retryStorage: false });
  const final = sessions.snapshot("p", id);
  assert.deepEqual(completed, [{ state: "unknown", messageIndex: 1 }]);
  assert.equal(final.requestMessages[0].sendState, "unknown");
  call.callback();
  call.emit("drain");
  assert.deepEqual(sessions.snapshot("p", id), final);
  assert.equal(completed.length, 1);
  assert.equal(call.writes, 1);
});

test("gRPC pre-submit observer failures make no writes or half-close and preserve writable state", (t) => {
  const { sessions, call, id } = fixture(t);
  const observer = {
    onSubmitted() {
      throw Error("bookkeeping refused");
    },
  };
  assert.throws(
    () => sessions.send("p", id, { text: "one" }, observer),
    /bookkeeping/,
  );
  assert.throws(() => sessions.halfClose("p", id, observer), /bookkeeping/);
  assert.equal(call.writes, 0);
  assert.equal(call.ends, 0);
  assert.deepEqual(sessions.snapshot("p", id).requestMessages, []);
  assert.equal(sessions.snapshot("p", id).requestState, "writable");
});

test("gRPC half-close observer completes once and only closes request direction", (t) => {
  const { sessions, call, id } = fixture(t);
  const completed = [];
  sessions.halfClose("p", id, { onComplete: (value) => completed.push(value) });
  assert.equal(sessions.snapshot("p", id).requestState, "halfClosing");
  assert.deepEqual(completed, []);
  call.endCallback();
  assert.deepEqual(completed, [{ state: "half-closed" }]);
  assert.equal(sessions.snapshot("p", id).lifecycle, "active");
  assert.equal(sessions.snapshot("p", id).requestState, "halfClosed");
  call.endCallback(Error("late failure"));
  assert.equal(sessions.snapshot("p", id).lifecycle, "active");
  assert.equal(completed.length, 1);
  assert.equal(call.ends, 1);
});

test("gRPC pending half-close becomes unknown, late success and observer throws cannot interrupt cleanup", async (t) => {
  const { sessions, call, id } = fixture(t);
  const completed = [];
  sessions.halfClose("p", id, {
    onComplete(value) {
      completed.push(value);
      throw Error("observer failure");
    },
  });
  await sessions.cancel("p", id, { retryStorage: false });
  const final = sessions.snapshot("p", id);
  assert.deepEqual(completed, [{ state: "unknown" }]);
  call.endCallback();
  assert.deepEqual(sessions.snapshot("p", id), final);
  assert.equal(completed.length, 1);
  assert.equal(call.ends, 1);
});

test("gRPC transport throw or callback failure reports unknown exactly once", async (t) => {
  for (const mode of ["throw", "callback"]) {
    const { sessions, call, id } = fixture(t);
    if (mode === "throw")
      call.write = function () {
        this.writes++;
        throw Error("ambiguous");
      };
    const completed = [];
    sessions.send(
      "p",
      id,
      { text: "one" },
      { onComplete: (value) => completed.push(value) },
    );
    if (mode === "callback") call.callback(Error("ambiguous"));
    await sessions.get("p", id).recordPromise;
    assert.deepEqual(completed, [{ state: "unknown", messageIndex: 1 }]);
    assert.equal(sessions.snapshot("p", id).lifecycle, "terminal");
    if (mode === "callback") call.callback();
    assert.equal(completed.length, 1);
    assert.equal(call.writes, 1);
  }
});

test("gRPC cancel no-retry preserves failed save; default owner cancel retains explicit recovery behavior", async (t) => {
  const f = fixture(t, { failSave: true });
  await f.sessions.cancel("p", f.id, { retryStorage: false });
  assert.equal(f.attempts, 1);
  assert.equal(f.sessions.snapshot("p", f.id).receiptState, "failed");
  await f.sessions.cancel("p", f.id, { retryStorage: false });
  assert.equal(f.attempts, 1);
  await f.sessions.cancel("p", f.id);
  assert.equal(f.attempts, 2);
  assert.equal(f.call.writes, 0);
  assert.equal(f.call.ends, 0);
});

test("gRPC synchronous half-close callback is not confirmed before end returns", async (t) => {
  for (const throws of [false, true]) {
    const { sessions, call, id } = fixture(t);
    const completed = [];
    call.end = function (callback) {
      this.ends++;
      callback();
      assert.deepEqual(completed, []);
      if (throws) throw Error("ambiguous after callback");
    };
    sessions.halfClose("p", id, {
      onComplete: (value) => completed.push(value),
    });
    assert.deepEqual(completed, [
      { state: throws ? "unknown" : "half-closed" },
    ]);
    assert.equal(call.ends, 1);
  }
});

test("gRPC local completion observer exceptions do not break the next write", (t) => {
  const { sessions, call, id } = fixture(t);
  sessions.send(
    "p",
    id,
    { text: "one" },
    {
      onComplete() {
        throw Error("observer failure");
      },
    },
  );
  call.callback();
  assert.equal(
    sessions.snapshot("p", id).requestMessages[0].sendState,
    "accepted",
  );
  sessions.send("p", id, { text: "two" });
  call.callback();
  assert.equal(call.writes, 2);
});

test("gRPC synchronous callback and drain cannot complete before write returns", (t) => {
  for (const order of ["callback-first", "drain-first"]) {
    const { sessions, call, id } = fixture(t);
    const completed = [];
    call.write = function (_message, callback) {
      this.writes++;
      if (order === "callback-first") {
        callback();
        this.emit("drain");
      } else {
        this.emit("drain");
        callback();
      }
      assert.deepEqual(completed, []);
      return false;
    };
    sessions.send(
      "p",
      id,
      { text: "one" },
      { onComplete: (value) => completed.push(value) },
    );
    assert.deepEqual(completed, [
      { state: "locally-written", messageIndex: 1 },
    ]);
    assert.equal(call.writes, 1);
  }
});

test("gRPC start submission marker follows atomic admission; observer failure releases resources without creating a client", async (t) => {
  const f = fixture(t),
    source = f.sessions.get("p", f.id).definition;
  let clients = 0,
    markers = 0;
  const create = f.sessions.createClient;
  f.sessions.createClient = (...args) => {
    clients++;
    return create(...args);
  };
  const failed = f.sessions.start(
    "p",
    source,
    {},
    {
      onSubmitted() {
        markers++;
        throw Error("observer failed");
      },
    },
  );
  const session = f.sessions.get("p", failed.id);
  assert.equal(clients, 0);
  assert.equal(markers, 1);
  assert.equal(failed.lifecycle, "terminal");
  assert.equal(session.timer._destroyed, true);
  await session.recordPromise;
  assert.equal(session.receiptState, "saved");
  // The failed observer must not consume an active slot; one initial stream + four new ones fit.
  for (let i = 0; i < 4; i++)
    f.sessions.start(
      "p",
      source,
      {},
      {
        onSubmitted() {
          markers++;
        },
      },
    );
  assert.equal(clients, 4);
  assert.equal(markers, 5);
  assert.throws(
    () =>
      f.sessions.start(
        "p",
        source,
        {},
        {
          onSubmitted() {
            markers++;
          },
        },
      ),
    /5/,
  );
  assert.equal(clients, 4);
  assert.equal(markers, 5);
  assert.throws(
    () =>
      f.sessions.start(
        "p",
        { ...source, timeoutMs: 30001 },
        {},
        {
          onSubmitted() {
            markers++;
          },
        },
      ),
    /超时/,
  );
  assert.equal(markers, 5);
});
