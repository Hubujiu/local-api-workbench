import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { MCPHTTPSessions } from "../src/mcp-http-sessions.mjs";
import { ProtocolSessions } from "../src/protocol-sessions.mjs";

test("HTTP owner identities survive request completion, revoke synchronously and drain", async () => {
  let release;
  const disposed = [];
  const registry = new MCPHTTPSessions({
    onDispose(owner, reason) {
      assert.equal(registry.owns(owner), false);
      disposed.push({ owner, reason });
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const id = registry.create();
  const first = registry.owner(id);
  assert(Object.isFrozen(first));
  assert.equal(registry.owns({ ...first }), false);
  const request = registry.begin(id, 1, true);
  request.finish();
  assert(registry.owns(first));
  registry.advance();
  assert.equal(disposed[0].reason, "authorization-changed");
  const second = registry.owner(id);
  assert.notEqual(first, second);
  assert(registry.owns(second));
  let drained = false;
  const drain = registry.drain().then(() => {
    drained = true;
  });
  await delay(1);
  assert.equal(drained, false);
  release();
  await drain;
  assert.equal(registry.delete(id), true);
  assert.equal(registry.owns(second), false);
  assert.equal(disposed[1].reason, "deleted");
  release();
  await registry.drain();
  registry.close();
});

test("idle HTTP owners actively expire without another request; close disposes only once", async () => {
  const disposed = [];
  const registry = new MCPHTTPSessions({
    idleMs: 15,
    onDispose: (owner, reason) => disposed.push(reason),
  });
  const id = registry.create();
  const owner = registry.owner(id);
  await delay(60);
  assert.equal(registry.owns(owner), false);
  assert.deepEqual(disposed, ["expired"]);
  const second = registry.create();
  const next = registry.owner(second);
  registry.close();
  registry.close();
  assert.equal(registry.owns(next), false);
  assert.deepEqual(disposed, ["expired", "closed"]);
  await registry.drain();
});

function fakeSession(send) {
  const manager = new ProtocolSessions();
  const session = {
    id: "test",
    type: "websocket",
    state: "open",
    events: [],
    bytes: 0,
    totalEvents: 0,
    createdAt: new Date().toISOString(),
    socket: { send, terminate() {} },
  };
  manager.sessions.set(session.id, session);
  return { manager, session };
}

test("send observers distinguish pre-submit rejection, local write and unknown terminal outcome", () => {
  let callback;
  const { manager, session } = fakeSession((data, options, done) => {
    callback = done;
  });
  const states = [];
  let submitted = 0;
  const observer = {
    onSubmitted() {
      submitted++;
    },
    onComplete(result) {
      states.push(result.state);
    },
  };
  manager.send(session.id, "one", observer);
  assert.equal(submitted, 1);
  callback();
  callback(Error("late"));
  assert.deepEqual(states, ["locally-written"]);
  manager.send(session.id, "two", observer);
  manager.stop(session.id);
  const terminal = structuredClone(session.finalSnapshot);
  callback();
  assert.deepEqual(states, ["locally-written", "unknown"]);
  assert.deepEqual(session.finalSnapshot, terminal);
  assert.equal(terminal.events[1].sendState, "queued");
  assert.throws(() => manager.send(session.id, "three", observer), /不可发送/);
  assert.equal(submitted, 2);
});

test("synchronous transport throw is unknown, closes and never retries", () => {
  let writes = 0;
  const { manager, session } = fakeSession(() => {
    writes++;
    throw Error("ambiguous write");
  });
  const states = [];
  manager.send(session.id, "one", {
    onComplete: (result) => states.push(result.state),
  });
  assert.equal(writes, 1);
  assert.deepEqual(states, ["unknown"]);
  assert.equal(session.state, "error");
  assert(session.finalSnapshot);
  manager.stop(session.id);
  assert.deepEqual(states, ["unknown"]);
});

test("transport callback error is unknown once and late success cannot mutate final evidence", () => {
  let callback;
  let writes = 0;
  const { manager, session } = fakeSession((_data, _options, done) => {
    writes++;
    callback = done;
  });
  const outcomes = [];
  manager.send(session.id, "one", {
    onComplete: (result) => outcomes.push(result.state),
  });
  callback(Error("write acknowledgement lost"));
  assert.deepEqual(outcomes, ["unknown"]);
  assert.equal(session.state, "error");
  assert.equal(session.finalSnapshot.events[0].sendState, "failed");
  const final = structuredClone(session.finalSnapshot);
  callback();
  callback(Error("late"));
  manager.stop(session.id);
  assert.deepEqual(session.finalSnapshot, final);
  assert.deepEqual(outcomes, ["unknown"]);
  assert.equal(writes, 1);
});

test("send observers preserve exact one-MiB payload and eight-MiB cumulative budgets", () => {
  let writes = 0;
  const { manager, session } = fakeSession((_data, _options, done) => {
    writes++;
    done();
  });
  let submitted = 0;
  const observer = {
    onSubmitted() {
      submitted++;
    },
  };
  assert.throws(
    () => manager.send(session.id, "x".repeat(1048577), observer),
    /1MiB/,
  );
  assert.equal(writes, 0);
  for (let n = 0; n < 8; n++)
    manager.send(session.id, "x".repeat(1048576), observer);
  assert.equal(session.bytes, 8 * 1048576);
  assert.equal(writes, 8);
  assert.throws(() => manager.send(session.id, "x", observer), /8 MiB/);
  assert.equal(writes, 8);
  assert.equal(submitted, 8);
  assert.equal(session.overflow, true);
  manager.stop(session.id);
});
