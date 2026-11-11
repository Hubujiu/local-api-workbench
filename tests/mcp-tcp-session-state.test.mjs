import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { MCPHTTPSessions } from "../src/mcp-http-sessions.mjs";
import { MCPWebSocketSessions } from "../src/mcp-websocket-sessions.mjs";
import { ProtocolSessions } from "../src/protocol-sessions.mjs";
async function wait(check) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw Error("TCP state fixture timeout");
    await delay(5);
  }
}
async function fixture(t) {
  const peers = new Set();
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => peers.delete(socket));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const project = {
    id: "p",
    protocols: [
      {
        id: "tcp",
        name: "original",
        type: "tcp",
        url: "127.0.0.1",
        port: server.address().port,
        receiveEncoding: "utf8",
      },
    ],
  };
  const store = { get: async () => project };
  const registry = new MCPHTTPSessions();
  const sessions = new ProtocolSessions({
    onFinish: (s) => {
      s.recordSaved = true;
      return Promise.resolve();
    },
  });
  const service = new MCPWebSocketSessions({
    sessions,
    store,
    owns: (o) => registry.owns(o),
  });
  registry.onDispose = (o, r) => service.dispose(o, r);
  const owner = registry.owner(registry.create());
  t.after(async () => {
    registry.close();
    await registry.drain();
    await sessions.close();
    for (const s of peers) s.destroy();
    await new Promise((r) => server.close(r));
  });
  const tcp = service.forProtocol("tcp");
  const call = (action, args = {}) =>
    tcp.call(action, owner, { projectId: "p", ...args });
  const start = async (operationId = "start") => {
    const op = await call("start", { definitionId: "tcp", operationId });
    assert.equal(op.state, "started", JSON.stringify(op));
    await wait(() => sessions.get(op.sessionId).state === "open");
    return op.sessionId;
  };
  return {
    project,
    store,
    registry,
    sessions,
    service,
    owner,
    tcp,
    call,
    start,
    peers,
  };
}
test("TCP adapter isolates session and operation types while sharing owner identity and idempotency", async (t) => {
  const f = await fixture(t);
  const sessionId = await f.start();
  const args = { projectId: "p", sessionId };
  for (const action of ["get", "renew", "stop"])
    assert.throws(() => f.service.call(action, f.owner, args));
  assert.throws(() =>
    f.service.call("operation", f.owner, {
      projectId: "p",
      operationId: "start",
    }),
  );
  assert.throws(() =>
    f.service.call("start", f.owner, {
      projectId: "p",
      definitionId: "tcp",
      operationId: "start",
    }),
  );
  for (const owner of [{ ...f.owner }, f.registry.owner(f.registry.create())])
    assert.throws(() => f.tcp.call("get", owner, args));
  assert.throws(() => f.call("get", { sessionId, projectId: "other" }));
  assert.equal(
    (await f.call("start", { definitionId: "tcp", operationId: "start" }))
      .sessionId,
    sessionId,
  );
  assert.equal(f.sessions.sessions.size, 1);
  assert.equal(f.call("get", { sessionId }).state, "open");
});
test("TCP and WebSocket cannot split the shared 200-operation ledger or evict old deduplication", async (t) => {
  const f = await fixture(t);
  const sessionId = await f.start();
  for (let i = 1; i < 200; i++) {
    const adapter = i % 2 ? f.tcp : f.service;
    const op = await adapter.call("start", f.owner, {
      projectId: "p",
      definitionId: "missing",
      operationId: "op" + i,
    });
    assert.equal(op.state, "failed-before-submit");
  }
  for (const adapter of [f.tcp, f.service])
    assert.throws(() =>
      adapter.call("start", f.owner, {
        projectId: "p",
        definitionId: "missing",
        operationId: "overflow",
      }),
    );
  assert.equal(
    (await f.call("start", { definitionId: "tcp", operationId: "start" }))
      .sessionId,
    sessionId,
  );
  assert.equal((await f.call("stop", { sessionId })).state, "closed");
  assert.equal(f.sessions.sessions.size, 1);
});
test("TCP delayed project read cannot admit a socket after ownership revocation", async (t) => {
  const f = await fixture(t);
  let release;
  f.store.get = () => new Promise((r) => (release = r));
  const pending = f.call("start", { definitionId: "tcp", operationId: "late" });
  assert.equal(typeof release, "function");
  f.registry.close();
  release(f.project);
  assert.equal((await pending).state, "failed-before-submit");
  await f.registry.drain();
  assert.equal(f.sessions.sessions.size, 0);
  assert.equal(f.peers.size, 0);
});
test("TCP keeps frozen definitions and freezes unknown send evidence against late callbacks", async (t) => {
  const f = await fixture(t);
  const sessionId = await f.start();
  const session = f.sessions.get(sessionId);
  const definition = structuredClone(session.definition);
  f.project.protocols[0].name = "changed";
  f.project.protocols[0].url = "invalid.example";
  let done,
    writes = 0;
  session.socket.write = (_bytes, callback) => {
    writes++;
    done = callback;
    return true;
  };
  const op = await f.call("send", {
    sessionId,
    operationId: "send",
    message: "payload",
  });
  assert.equal(op.state, "pending");
  const duplicate = await f.call("send", {
    sessionId,
    operationId: "send",
    message: "payload",
  });
  assert.equal(duplicate.state, "pending");
  const competing = await f.call("send", {
    sessionId,
    operationId: "compete",
    message: "other",
  });
  assert.equal(competing.state, "failed-before-submit");
  await f.call("stop", { sessionId });
  const frozen = structuredClone(session.finalSnapshot);
  assert.equal(f.call("operation", { operationId: "send" }).state, "unknown");
  done();
  assert.equal(f.call("operation", { operationId: "send" }).state, "unknown");
  assert.deepEqual(session.finalSnapshot, frozen);
  assert.deepEqual(session.definition, definition);
  assert.equal(writes, 1);
  assert.throws(() => f.call("renew", { sessionId }));
  assert.equal(
    (await f.call("send", { sessionId, operationId: "ended", message: "x" }))
      .state,
    "failed-before-submit",
  );
});
test("TCP retains one-MiB sends, eight-MiB cumulative data and bounded pages", async (t) => {
  const f = await fixture(t);
  const sessionId = await f.start();
  const session = f.sessions.get(sessionId);
  let writes = 0;
  session.socket.write = (_bytes, done) => {
    writes++;
    done();
    return true;
  };
  assert.throws(() =>
    f.call("send", {
      sessionId,
      operationId: "too-large",
      message: "x".repeat(1048577),
    }),
  );
  for (let i = 0; i < 8; i++)
    assert.equal(
      (
        await f.call("send", {
          sessionId,
          operationId: "send" + i,
          message: "x".repeat(1048576),
        })
      ).state,
      "locally-written",
    );
  assert.equal(
    (await f.call("send", { sessionId, operationId: "ninth", message: "x" }))
      .state,
    "failed-before-submit",
  );
  assert.equal(writes, 8);
  const page = f.call("get", { sessionId, limit: 2 });
  assert.equal(page.events.length, 2);
  assert.equal(page.events[0].data.length, 4096);
  assert.equal(page.dataBytes, 8388608);
  assert.throws(() => f.call("get", { sessionId, limit: 21 }));
});
test("TCP rejects saved unsupported fields and mismatched definition protocol before connection", async (t) => {
  const f = await fixture(t);
  const saved = structuredClone(f.project.protocols[0]);
  for (const [index, change] of [
    { type: "websocket", url: "ws://127.0.0.1" },
    { headers: { Authorization: "secret" } },
    { completion: "delimiter", delimiterHex: "0a" },
    { handshake: {} },
    { duration: 1000 },
    { message: { value: "invalid" } },
    { message: "\ud800" },
    { message: "x".repeat(1048577) },
  ].entries()) {
    f.project.protocols[0] = { ...saved, ...change };
    const op = await f.call("start", {
      definitionId: "tcp",
      operationId: "invalid" + index,
    });
    assert.equal(op.state, "failed-before-submit");
  }
  assert.equal(f.sessions.sessions.size, 0);
  assert.equal(f.peers.size, 0);
});

test("TCP delayed send rechecks revoked owner before socket write", async (t) => {
  const f = await fixture(t);
  const sessionId = await f.start();
  const session = f.sessions.get(sessionId);
  let writes = 0,
    release;
  session.socket.write = () => {
    writes++;
    return true;
  };
  f.store.get = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = f.call("send", {
    sessionId,
    operationId: "late-send",
    message: "never-sent",
  });
  assert.equal(typeof release, "function");
  f.registry.close();
  release(f.project);
  assert.equal((await pending).state, "failed-before-submit");
  await f.registry.drain();
  assert.equal(writes, 0);
  assert.equal(session.state, "closed");
});

test("TCP adapter cannot consume WebSocket-owned session or operation identities", async (t) => {
  const { WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const f = await fixture(t);
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  f.project.protocols.push({
    id: "ws",
    name: "socket",
    type: "websocket",
    url: `ws://127.0.0.1:${server.address().port}`,
  });
  const op = await f.service.call("start", f.owner, {
    projectId: "p",
    definitionId: "ws",
    operationId: "ws-start",
  });
  assert.equal(op.state, "started");
  await wait(() => f.sessions.get(op.sessionId).state === "open");
  for (const action of ["get", "renew", "stop"])
    assert.throws(() => f.call(action, { sessionId: op.sessionId }));
  assert.throws(() => f.call("operation", { operationId: "ws-start" }));
  assert.throws(() =>
    f.call("start", { definitionId: "tcp", operationId: "ws-start" }),
  );
  assert.equal(
    (
      await f.call("send", {
        sessionId: op.sessionId,
        operationId: "wrong-type",
        message: "never-sent",
      })
    ).state,
    "failed-before-submit",
  );
  assert.equal(
    f.service.call("get", f.owner, { projectId: "p", sessionId: op.sessionId })
      .totalEvents,
    0,
  );
});

test("TCP saved initial message remains frozen metadata and is not automatically transmitted", async (t) => {
  const f = await fixture(t);
  f.project.protocols[0].message = "saved-but-not-submitted";
  const sessionId = await f.start();
  const session = f.sessions.get(sessionId);
  await delay(20);
  assert.equal(session.definition.message, "saved-but-not-submitted");
  assert.equal(session.totalEvents, 0);
  assert.equal(session.bytes, 0);
  assert.equal(session.socket.bytesWritten, 0);
});

test("TCP and WebSocket share fifty retained slots and cannot discard unsaved terminal evidence", async (t) => {
  const { WebSocketServer } = await import("ws");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const f = await fixture(t);
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  f.sessions.onFinish = () => Promise.resolve(); // save outcome is deliberately unconfirmed
  f.project.protocols.push({
    id: "ws",
    name: "socket",
    type: "websocket",
    url: `ws://127.0.0.1:${server.address().port}`,
  });
  for (let i = 0; i < 50; i++) {
    const adapter = i % 2 ? f.service : f.tcp;
    const op = await adapter.call("start", f.owner, {
      projectId: "p",
      definitionId: i % 2 ? "ws" : "tcp",
      operationId: "retained" + i,
    });
    assert.equal(op.state, "started");
    await wait(() => f.sessions.get(op.sessionId).state === "open");
    await adapter.call("stop", f.owner, {
      projectId: "p",
      sessionId: op.sessionId,
    });
    assert.equal(f.sessions.discard(f.sessions.get(op.sessionId)), false);
  }
  const before = [...f.sessions.sessions.keys()];
  assert.equal(before.length, 50);
  assert.equal(
    [...f.sessions.sessions.values()].filter((s) => s.type === "tcp").length,
    25,
  );
  for (const [type, adapter] of [
    ["tcp", f.tcp],
    ["ws", f.service],
  ]) {
    const result = await adapter.call("start", f.owner, {
      projectId: "p",
      definitionId: type,
      operationId: "overflow-" + type,
    });
    assert.notEqual(result.state, "started");
    assert.equal(result.retrySafe, false);
    assert.deepEqual([...f.sessions.sessions.keys()], before);
  }
});

test("TCP event history retains two hundred entries and reports dropped and truncated pages", async (t) => {
  const f = await fixture(t);
  const sessionId = await f.start();
  const session = f.sessions.get(sessionId);
  for (let i = 0; i < 205; i++)
    f.sessions.event(session, "received", String(i) + ":" + "x".repeat(5000));
  assert.equal(session.events.length, 200);
  const page = f.call("get", { sessionId, afterEvent: 0, limit: 2 });
  assert.equal(page.droppedBeforePage, 5);
  assert.deepEqual(
    page.events.map((e) => e.sequence),
    [6, 7],
  );
  assert.equal(page.nextAfterEvent, 7);
  assert.equal(page.hasMore, true);
  for (const e of page.events) {
    assert.equal(e.truncated, true);
    assert.equal(e.data.length, 4096);
    assert(e.dataBytes > 5000);
  }
  const tail = f.call("get", { sessionId, afterEvent: 204, limit: 20 });
  assert.deepEqual(
    tail.events.map((e) => e.sequence),
    [205],
  );
  assert.equal(tail.hasMore, false);
});
