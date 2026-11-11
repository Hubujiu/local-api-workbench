import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MCPGrpcSessions } from "../src/mcp-grpc-sessions.mjs";
import { MCPHTTPSessions } from "../src/mcp-http-sessions.mjs";
import { GrpcSessions } from "../src/grpc-sessions.mjs";

const proto = `syntax="proto3"; package test; message Msg {string text=1;} service Chat {rpc Bidi(stream Msg) returns(stream Msg);}`;
function fixture(t) {
  const project = {
    id: "p",
    settings: {
      grpcDefinitions: [
        {
          id: "d",
          name: "test",
          target: "grpc://127.0.0.1:1",
          proto,
          service: "test.Chat",
          method: "Bidi",
          timeoutMs: 30000,
        },
      ],
    },
    protocolRuns: [],
  };
  const calls = [];
  const store = {
    get: async () => project,
    append: async (_id, _field, r) => project.protocolRuns.push(r),
  };
  const sessions = new GrpcSessions({
    store,
    createClient: () => {
      const call = new EventEmitter();
      Object.assign(call, {
        writes: [],
        ends: 0,
        write(message, callback) {
          this.writes.push({ message, callback });
          return false;
        },
        end(callback) {
          this.ends++;
          this.endCallback = callback;
        },
        cancel() {},
      });
      calls.push(call);
      return { makeBidiStreamRequest: () => call, close() {} };
    },
  });
  const registry = new MCPHTTPSessions();
  const service = new MCPGrpcSessions({
    sessions,
    store,
    owns: (o) => registry.owns(o),
  });
  registry.onDispose = (o) => service.dispose(o);
  const id = registry.create(),
    owner = registry.owner(id);
  t.after(async () => {
    registry.close();
    await registry.drain();
    await sessions.close();
  });
  const args = { projectId: "p", definitionId: "d", operationId: "start" };
  const start = () => service.call("start", owner, args);
  return {
    project,
    store,
    sessions,
    registry,
    service,
    id,
    owner,
    args,
    start,
    calls,
  };
}
test("gRPC operation admission reserves IDs, rejects concurrent writes and half-close, waits callback AND drain", async (t) => {
  const f = fixture(t),
    start = await f.start(),
    target = { projectId: "p", sessionId: start.sessionId };
  assert.equal(start.state, "started");
  assert.equal((await f.start()).sessionId, start.sessionId);
  assert.equal(f.calls.length, 1);
  assert.throws(
    () =>
      f.service.call("start", f.owner, { ...f.args, definitionId: "other" }),
    /different/,
  );
  const args = { ...target, operationId: "send", message: { text: "one" } };
  assert.equal((await f.service.call("send", f.owner, args)).state, "pending");
  assert.equal((await f.service.call("send", f.owner, args)).state, "pending");
  assert.equal(
    (await f.service.call("send", f.owner, { ...args, operationId: "second" }))
      .state,
    "failed-before-submit",
  );
  assert.equal(
    (
      await f.service.call("half_close", f.owner, {
        ...target,
        operationId: "early-end",
      })
    ).state,
    "failed-before-submit",
  );
  f.calls[0].writes[0].callback();
  assert.equal((await f.service.call("send", f.owner, args)).state, "pending");
  f.calls[0].emit("drain");
  assert.equal(
    (await f.service.call("send", f.owner, args)).state,
    "locally-written",
  );
  const endArgs = { ...target, operationId: "end" };
  assert.equal(
    (await f.service.call("half_close", f.owner, endArgs)).state,
    "pending",
  );
  assert.equal(
    (await f.service.call("half_close", f.owner, endArgs)).state,
    "pending",
  );
  await f.service.call("cancel", f.owner, target);
  assert.equal(
    (await f.service.call("half_close", f.owner, endArgs)).state,
    "unknown",
  );
  const frozen = structuredClone(
    f.sessions.get("p", start.sessionId).finalSnapshot,
  );
  f.calls[0].endCallback();
  assert.deepEqual(f.sessions.get("p", start.sessionId).finalSnapshot, frozen);
  assert.equal(f.calls[0].ends, 1);
  assert.equal(f.calls[0].writes.length, 1);
});
test("pending store start is deduplicated and revoked before any client construction", async (t) => {
  const f = fixture(t);
  let release;
  f.store.get = () => new Promise((r) => (release = r));
  const pending = f.start();
  assert.equal((await f.start()).state, "pending");
  f.registry.delete(f.id);
  release(f.project);
  assert.equal((await pending).state, "failed-before-submit");
  await f.registry.drain();
  assert.equal(f.calls.length, 0);
});
test("pending send project lookup cannot submit after owner revocation", async (t) => {
  const f = fixture(t),
    start = await f.start();
  let release;
  const original = f.store.get;
  let first = true;
  f.store.get = () =>
    first ? ((first = false), new Promise((r) => (release = r))) : original();
  const pending = f.service.call("send", f.owner, {
    projectId: "p",
    sessionId: start.sessionId,
    operationId: "send",
    message: { text: "never" },
  });
  f.registry.delete(f.id);
  release(f.project);
  assert.equal((await pending).state, "failed-before-submit");
  await f.registry.drain();
  assert.equal(f.calls[0].writes.length, 0);
});
test("gRPC pages are bounded and non-renewing; ledger never evicts and cancel works at capacity", async (t) => {
  const f = fixture(t),
    start = await f.start(),
    target = { projectId: "p", sessionId: start.sessionId };
  const session = f.sessions.get("p", start.sessionId),
    deadline = session.view.deadlineAt;
  for (let i = 0; i < 25; i++)
    f.calls[0].emit("data", { text: i === 0 ? "x".repeat(5000) : String(i) });
  const page = f.service.call("get", f.owner, target);
  assert.equal(page.messages.length, 20);
  assert(page.hasMore);
  assert.equal(page.messages[0].truncated, true);
  assert.equal(page.messages[0].preview.length, 4096);
  assert.equal(page.deadlineAt, deadline);
  const next = f.service.call("get", f.owner, {
    ...target,
    afterMessage: page.nextAfterMessage,
  });
  assert.equal(next.messages.length, 5);
  assert.equal(next.hasMore, false);
  for (let i = 0; i < 199; i++)
    await f.service.call("send", f.owner, {
      ...target,
      sessionId: "missing",
      operationId: "failed" + i,
      message: { text: "x" },
    });
  assert.throws(
    () =>
      f.service.call("send", f.owner, {
        ...target,
        operationId: "overflow",
        message: { text: "x" },
      }),
    /ledger/,
  );
  assert.equal((await f.start()).sessionId, start.sessionId);
  await f.service.call("cancel", f.owner, target);
  assert.equal(f.calls[0].writes.length, 0);
});
test("gRPC total deadline cannot be extended by reads or late sends", async (t) => {
  const f = fixture(t),
    start = await f.start(),
    target = { projectId: "p", sessionId: start.sessionId };
  const session = f.sessions.get("p", start.sessionId);
  session.started -= 30001;
  const send = await f.service.call("send", f.owner, {
    ...target,
    operationId: "late",
    message: { text: "never" },
  });
  assert.equal(send.state, "failed-before-submit");
  assert.equal(f.calls[0].writes.length, 0);
  const page = f.service.call("get", f.owner, target);
  assert.equal(page.lifecycle, "terminal");
  assert.equal(page.terminationReason, "deadline");
});

test("gRPC definite quota refusal remains failed-before-submit with no client creation or replay", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await f.service.call("start", f.owner, {
          ...f.args,
          operationId: "start" + i,
        })
      ).state,
      "started",
    );
  const args = { ...f.args, operationId: "full" };
  const denied = await f.service.call("start", f.owner, args);
  assert.equal(denied.state, "failed-before-submit");
  assert.equal(denied.sessionId, undefined);
  assert.equal(f.calls.length, 5);
  assert.equal(
    (await f.service.call("start", f.owner, args)).state,
    "failed-before-submit",
  );
  assert.equal(f.calls.length, 5);
});
