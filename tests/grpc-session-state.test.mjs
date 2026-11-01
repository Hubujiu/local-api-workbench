import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { GrpcSessions } from "../src/grpc-sessions.mjs";
import { GrpcSlots } from "../src/grpc-slots.mjs";
import { ProjectCommitUncertain } from "../src/project-commit-outcome.mjs";
import {
  validateGrpcSessionRecord,
  grpcSessionHash,
  validateGrpcSessionHistory,
} from "../src/grpc-session-evidence.mjs";

// Deterministic state-machine acceptance; no real sockets in this file.
const proto = `syntax = "proto3"; package state;
message Value { string text = 1; int32 count = 2; }
service Echo { rpc Chat(stream Value) returns(stream Value); rpc Collect(stream Value) returns(Value); rpc Watch(Value) returns(stream Value); rpc Unary(Value) returns(Value); }`;
const definition = (method = "Chat", extra = {}) => ({
  id: "definition",
  name: "State fixture",
  target: "grpc://127.0.0.1:1",
  proto,
  service: "state.Echo",
  method,
  timeoutMs: 30000,
  ...extra,
});
function fixture(t, { store, slots, ready = true, throwCreate = false } = {}) {
  const records = [],
    calls = [];
  let appends = 0,
    gets = 0;
  store ??= {
    async get() {
      gets++;
      return { protocolRuns: structuredClone(records) };
    },
    async append(_project, _field, record) {
      appends++;
      records.unshift(structuredClone(record));
    },
  };
  const sessions = new GrpcSessions({
    store,
    slots,
    createClient() {
      if (throwCreate) throw Error("fake construction failure");
      const call = new EventEmitter();
      Object.assign(call, {
        writes: [],
        cancels: 0,
        closes: 0,
        ends: 0,
        write(message, callback) {
          this.writes.push({ message: structuredClone(message), callback });
          return ready;
        },
        end(callback) {
          this.ends++;
          this.endCallback = callback;
        },
        cancel() {
          this.cancels++;
        },
      });
      calls.push(call);
      return {
        makeBidiStreamRequest() {
          return call;
        },
        makeServerStreamRequest(_path, _serialize, _deserialize, message) {
          call.initial = structuredClone(message);
          return call;
        },
        makeClientStreamRequest(...args) {
          call.callback = args.at(-1);
          return call;
        },
        close() {
          call.closes++;
        },
      };
    },
  });
  t.after(() => sessions.close());
  const open = (method = "Chat", input = {}) =>
    sessions.start("project", definition(method), input);
  const snapshot = (id) => sessions.snapshot("project", id);
  const saved = async (id) => {
    await sessions.get("project", id).recordPromise;
    return snapshot(id);
  };
  return {
    sessions,
    calls,
    records,
    open,
    snapshot,
    saved,
    get appends() {
      return appends;
    },
    get gets() {
      return gets;
    },
  };
}

test("client callback failure with remote OK remains failed, regardless of ordering", async (t) => {
  for (const statusFirst of [false, true]) {
    const f = fixture(t),
      { id } = f.open("Collect"),
      call = f.calls.at(-1);
    if (statusFirst) call.emit("status", { code: 0, details: "OK" });
    call.callback({ code: 12, details: "No message received" });
    if (!statusFirst) {
      assert.equal(f.snapshot(id).lifecycle, "active");
      call.emit("status", { code: 0, details: "OK" });
    }
    const result = await f.saved(id);
    assert.equal(result.lifecycle, "terminal");
    assert.equal(result.status.code, 12);
    assert.equal(result.remoteStatus.code, 0);
    assert.equal(result.callback.responseReceived, false);
    assert.equal(result.receiptState, "saved");
    assert.equal(f.records[0].status, "failed");
    assert.equal(f.appends, 1);
  }
});

test("readable end alone is not success; terminal evidence ignores every late event", async (t) => {
  const f = fixture(t),
    { id } = f.open(),
    call = f.calls[0];
  call.emit("data", { text: "partial" });
  call.emit("end");
  assert.equal(f.snapshot(id).lifecycle, "active");
  call.emit("error", { code: 7, details: "denied" });
  assert.equal(f.snapshot(id).lifecycle, "active");
  call.emit("status", { code: 7, details: "denied" });
  const before = await f.saved(id),
    record = structuredClone(f.records[0]);
  for (const [event, value] of [
    ["data", { text: "late" }],
    ["status", { code: 0, details: "OK" }],
    ["error", { code: 2 }],
    ["end", undefined],
  ])
    call.emit(event, value);
  assert.deepEqual(f.snapshot(id), before);
  before.messages[0].text = "caller mutation";
  before.status.code = 0;
  assert.deepEqual(f.records[0], record);
  assert.equal(f.snapshot(id).status.code, 7);
  assert.equal(f.snapshot(id).messages[0].text, "partial");
  assert.equal(call.closes, 1);
  assert.equal(f.appends, 1);
});

test("single outstanding write waits for callback AND drain, then half-close only closes requests", async (t) => {
  const f = fixture(t, { ready: false }),
    { id } = f.open(),
    call = f.calls[0];
  assert.equal(
    f.sessions.send("project", id, { text: "one" }).requestMessages[0]
      .sendState,
    "pending",
  );
  assert.throws(() => f.sessions.send("project", id, { text: "two" }), /发送/);
  assert.throws(() => f.sessions.halfClose("project", id), /发送/);
  call.writes[0].callback();
  assert.equal(f.snapshot(id).requestMessages[0].sendState, "pending");
  assert.throws(() => f.sessions.halfClose("project", id), /发送/);
  call.emit("drain");
  assert.equal(f.snapshot(id).requestMessages[0].sendState, "accepted");
  assert.equal(f.sessions.halfClose("project", id).requestState, "halfClosing");
  call.endCallback();
  assert.equal(f.snapshot(id).requestState, "halfClosed");
  assert.equal(f.snapshot(id).lifecycle, "active");
  call.emit("data", { text: "after half-close" });
  call.emit("status", { code: 0, details: "OK" });
  assert.equal(f.snapshot(id).lifecycle, "active");
  call.emit("end");
  const result = await f.saved(id);
  assert.equal(result.receiptState, "saved");
  assert.equal(result.messages[0].text, "after half-close");
  assert.equal(f.records[0].status, "completed");
});

test("cancel during pending write freezes unknown local send and never retries lost acknowledgement", async (t) => {
  const f = fixture(t, { ready: false }),
    { id } = f.open(),
    call = f.calls[0];
  f.sessions.send("project", id, { count: 1 });
  const [first, second] = await Promise.all([
    f.sessions.cancel("project", id),
    f.sessions.cancel("project", id),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.requestMessages[0].sendState, "unknown");
  call.writes[0].callback();
  call.emit("drain");
  call.emit("status", { code: 0, details: "late OK" });
  call.emit("end");
  assert.deepEqual(f.snapshot(id), first);
  await f.sessions.reconcile("project", id);
  assert.equal(call.writes.length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.appends, 1);
});

test("deadline guards prevent send/half-close/data/status after total budget even before timer dispatch", async (t) => {
  for (const action of ["send", "half-close", "data", "status", "callback"]) {
    const f = fixture(t),
      { id } = f.open(action === "callback" ? "Collect" : "Chat"),
      call = f.calls[0];
    if (action === "status") call.emit("end");
    f.sessions.get("project", id).started -= 30001;
    if (action === "send")
      assert.throws(() => f.sessions.send("project", id, {}));
    else if (action === "half-close")
      assert.throws(() => f.sessions.halfClose("project", id));
    else if (action === "callback") call.callback(null, { text: "too late" });
    else
      call.emit(
        action,
        action === "data" ? { text: "too late" } : { code: 0, details: "OK" },
      );
    const result = await f.saved(id);
    assert.equal(result.status.code, 4);
    assert.equal(result.terminationReason, "deadline");
    assert.equal(result.messages.length, 0);
    assert.equal(call.writes.length, 0);
    assert.equal(call.ends, 0);
    assert.equal(result.receiptState, "saved");
  }
});

test("received invalid JSON evidence is rejected before retention; Unicode status remains saveable", async (t) => {
  const deep = {};
  let current = deep;
  for (let i = 0; i < 70; i++) current = current.nested = {};
  for (const message of [
    { text: "\ud800" },
    { value: Infinity },
    { nested: { constructor: "unsafe" } },
    deep,
  ]) {
    const f = fixture(t),
      { id } = f.open();
    f.calls[0].emit("data", message);
    const result = await f.saved(id);
    assert.equal(result.status.code, 15);
    assert.equal(result.receiptState, "saved");
    assert.deepEqual(result.messages, []);
  }
  const f = fixture(t),
    { id } = f.open();
  f.calls[0].emit("end");
  f.calls[0].emit("status", { code: 7, details: "x".repeat(1999) + "😀" });
  const result = await f.saved(id);
  assert(result.status.details.isWellFormed());
  assert.equal(result.receiptState, "saved");
});

test("preflight and synchronous constructor failure cannot leak shared slots", async (t) => {
  const slots = new GrpcSlots(),
    f = fixture(t, { slots, throwCreate: true });
  assert.throws(() => f.open("Unary"));
  assert.throws(() => f.open("Watch"));
  assert.throws(() => f.open("Chat", { message: {} }));
  for (let i = 0; i < 6; i++) {
    const { id } = f.open();
    assert.equal((await f.saved(id)).receiptState, "saved");
  }
  const releases = Array.from({ length: 5 }, () => slots.acquire());
  assert.throws(() => slots.acquire(), /5/);
  releases.forEach((release) => {
    release();
    release();
  });
  const release = slots.acquire();
  release();
});

test("unknown and generic saves are singleflight, GET is inert, explicit reconciliation is storage only", async (t) => {
  for (const committed of [false, true]) {
    let writes = 0,
      reads = 0,
      fail = true;
    const records = [];
    const store = {
      async get() {
        reads++;
        return { protocolRuns: structuredClone(records) };
      },
      async append(project, _field, record) {
        writes++;
        if (!fail || committed) records.unshift(structuredClone(record));
        if (fail) {
          if (committed)
            throw new ProjectCommitUncertain(project, Error("lost ack"));
          throw Error("disk unavailable");
        }
      },
    };
    const f = fixture(t, { store }),
      { id } = f.open();
    const failed = await f.sessions.cancel("project", id);
    assert.equal(failed.receiptState, committed ? "unknown" : "failed");
    assert.equal(failed.recordSaved, false);
    assert.equal(failed.persistenceOutcome.retry_safe, false);
    const readCount = reads;
    for (let i = 0; i < 4; i++) f.snapshot(id);
    assert.equal(reads, readCount);
    assert.equal(writes, 1);
    fail = false;
    const results = await Promise.all([
      f.sessions.reconcile("project", id),
      f.sessions.cancel("project", id),
      f.sessions.reconcile("project", id),
    ]);
    assert(results.every((result) => result.receiptState === "saved"));
    assert.equal(records.length, 1);
    assert.equal(writes, committed ? 1 : 2);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].writes.length, 0);
  }
});

test("fifty unresolved retained receipts block admission; a confirmed record can be reclaimed", async (t) => {
  let failing = true;
  const records = [];
  const store = {
    async get() {
      return { protocolRuns: structuredClone(records) };
    },
    async append(_p, _f, record) {
      if (failing) throw Error("disk");
      records.push(structuredClone(record));
    },
  };
  const f = fixture(t, { store }),
    ids = [];
  for (let i = 0; i < 50; i++) {
    const { id } = f.open();
    ids.push(id);
    assert.equal(
      (await f.sessions.cancel("project", id)).receiptState,
      "failed",
    );
  }
  assert.throws(() => f.open(), /50/);
  assert.equal(f.calls.length, 50);
  failing = false;
  await f.sessions.reconcile("project", ids[0]);
  const next = f.open();
  assert.equal(f.calls.length, 51);
  assert.throws(() => f.snapshot(ids[0]));
  await f.sessions.cancel("project", next.id);
});

test("shutdown waits for pending persistence without retrying failed receipts or admitting late opens", async (t) => {
  let release,
    appends = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const store = {
    async get() {
      return { protocolRuns: [] };
    },
    async append() {
      appends++;
      await gate;
      throw Error("disk");
    },
  };
  const f = fixture(t, { store });
  f.open();
  let done = false;
  const closing = f.sessions.close().then((value) => {
    done = true;
    return value;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(done, false);
  assert.throws(() => f.open(), /关闭/);
  release();
  const receipts = await closing;
  assert.equal(receipts[0].receiptState, "failed");
  assert.equal(receipts[0].recordSaved, false);
  await f.sessions.close();
  await f.sessions.reconcile("project", receipts[0].sessionId);
  assert.equal(appends, 1);
});

test("session codec rejects forged metrics, added credentials and conflicting same-ID storage", async (t) => {
  const f = fixture(t),
    { id } = f.open();
  await f.sessions.cancel("project", id);
  const record = f.records[0];
  assert.throws(
    () =>
      validateGrpcSessionHistory([
        record,
        ...Array.from({ length: 49 }, (_, index) => ({
          id: "legacy-" + index,
        })),
        structuredClone(record),
      ]),
    /歧义/,
  );
  assert.throws(
    () => validateGrpcSessionHistory([{ id: record.id, type: "tcp" }, record]),
    /歧义/,
  );
  for (const mutate of [
    (x) => {
      x.result.requestBytes = 1;
    },
    (x) => {
      x.result.metadata = [{ key: "authorization", value: "secret" }];
    },
    (x) => {
      x.definition.tls = { key: "secret" };
    },
    (x) => {
      x.result.lifecycle = "active";
    },
    (x) => {
      x.result.status.code = 0;
    },
  ]) {
    const invalid = structuredClone(record);
    mutate(invalid);
    invalid.resultHash = grpcSessionHash(invalid.result);
    assert.throws(() => validateGrpcSessionRecord(invalid));
  }
  const backwards = structuredClone(record);
  backwards.finishedAt = backwards.result.finishedAt = new Date(
    Date.parse(record.createdAt) - 1000,
  ).toISOString();
  backwards.resultHash = grpcSessionHash(backwards.result);
  assert.doesNotThrow(() => validateGrpcSessionRecord(backwards));
  const conflict = structuredClone(record);
  conflict.result.status.details = "another result under same ID";
  conflict.resultHash = grpcSessionHash(conflict.result);
  f.records[0] = conflict;
  f.sessions.get("project", id).receiptState = "failed";
  const reconciled = await f.sessions.reconcile("project", id);
  assert.equal(reconciled.receiptState, "failed");
  assert.equal(f.appends, 1);
  assert.equal(f.records[0].resultHash, conflict.resultHash);
});
