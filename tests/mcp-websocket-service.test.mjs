import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { MCPHTTPSessions } from "../src/mcp-http-sessions.mjs";
import { MCPWebSocketSessions } from "../src/mcp-websocket-sessions.mjs";
import { ProtocolSessions } from "../src/protocol-sessions.mjs";

async function wait(check) {
  const until = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > until) throw Error("fixture timeout");
    await delay(5);
  }
}
async function fixture(t, options = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  let connections = 0;
  const messages = [];
  server.on("connection", (socket) => {
    connections++;
    socket.send("challenge");
    socket.on("message", (data) => {
      messages.push(data.toString());
      socket.send("echo:" + data);
    });
  });
  const project = {
    id: "project",
    protocols: [
      {
        id: "definition",
        name: "saved",
        type: "websocket",
        url: `ws://127.0.0.1:${server.address().port}`,
      },
    ],
  };
  const sessions = new ProtocolSessions({ onFinish: options.onFinish });
  const registry = new MCPHTTPSessions();
  const service = new MCPWebSocketSessions({
    sessions,
    store: options.store || {
      get: async (id) => (id === project.id ? project : undefined),
    },
    owns: (owner) => registry.owns(owner),
    ...options.service,
  });
  registry.onDispose = (owner, reason) => service.dispose(owner, reason);
  const httpId = registry.create();
  const owner = registry.owner(httpId);
  const startArgs = {
    projectId: "project",
    definitionId: "definition",
    operationId: "start",
  };
  const start = async (operationId = "start") => {
    const op = await service.call("start", owner, {
      ...startArgs,
      operationId,
    });
    assert.equal(op.state, "started", JSON.stringify(op));
    await wait(() => sessions.get(op.sessionId).state === "open");
    return { projectId: "project", sessionId: op.sessionId };
  };
  t.after(async () => {
    registry.close();
    await registry.drain();
    await sessions.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    server,
    registry,
    service,
    sessions,
    project,
    owner,
    httpId,
    startArgs,
    start,
    messages,
    connections: () => connections,
  };
}

test("HTTP WebSocket service binds owner/project/epoch and deduplicates real challenge-response", async (t) => {
  const f = await fixture(t);
  const target = await f.start();
  assert.equal(f.connections(), 1);
  const duplicate = await f.service.call("start", f.owner, f.startArgs);
  assert.equal(duplicate.sessionId, target.sessionId);
  const stranger = f.registry.owner(f.registry.create());
  for (const owner of [undefined, { ...f.owner }, stranger])
    assert.throws(() => f.service.call("get", owner, target), /owner|HTTP/);
  assert.throws(
    () => f.service.call("get", f.owner, { ...target, projectId: "other" }),
    /project/,
  );
  assert.throws(
    () =>
      f.service.call("start", f.owner, {
        ...f.startArgs,
        definitionId: "different",
      }),
    /different content/,
  );
  const args = {
    ...target,
    operationId: "send",
    message: "challenge-response",
  };
  await f.service.call("send", f.owner, args);
  await wait(() => f.messages.length === 1);
  const again = await f.service.call("send", f.owner, args);
  assert.equal(again.state, "locally-written");
  assert.equal(again.remoteConfirmed, false);
  assert.equal(again.retrySafe, false);
  assert.throws(
    () => f.service.call("send", f.owner, { ...args, message: "different" }),
    /different content/,
  );
  await delay(15);
  assert.deepEqual(f.messages, ["challenge-response"]);
  f.registry.advance();
  assert.throws(() => f.service.call("get", f.owner, target), /HTTP/);
  const replacement = f.registry.owner(f.httpId);
  assert.throws(() => f.service.call("get", replacement, target), /owner/);
  await f.registry.drain();
  await wait(() => f.server.clients.size === 0);
  assert.equal(f.connections(), 1);
});

test("pending start reserves operation before store read and disposal prevents late network admission", async (t) => {
  let resolve;
  const f = await fixture(t, {
    store: {
      get: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  });
  const pending = f.service.call("start", f.owner, f.startArgs);
  assert.equal(
    (await f.service.call("start", f.owner, f.startArgs)).state,
    "pending",
  );
  f.registry.delete(f.httpId);
  resolve(f.project);
  assert.equal((await pending).state, "failed-before-submit");
  await f.registry.drain();
  assert.equal(f.connections(), 0);
});

test("unconfirmed send rejects concurrency; terminal unknown and late callback never replay", async (t) => {
  const f = await fixture(t);
  const target = await f.start();
  const session = f.sessions.get(target.sessionId);
  let callback;
  let writes = 0;
  // Controlled transport callback boundary, after a real handshake.
  session.socket.send = (_data, _options, done) => {
    writes++;
    callback = done;
  };
  const args = { ...target, operationId: "pending", message: "one" };
  assert.equal((await f.service.call("send", f.owner, args)).state, "pending");
  assert.equal((await f.service.call("send", f.owner, args)).state, "pending");
  const concurrent = await f.service.call("send", f.owner, {
    ...args,
    operationId: "concurrent",
  });
  assert.equal(concurrent.state, "failed-before-submit");
  assert.match(concurrent.error, /No automatic network retry/);
  const stopped = await f.service.call("stop", f.owner, target);
  assert.equal(stopped.recordSaved, false);
  assert.equal((await f.service.call("send", f.owner, args)).state, "unknown");
  callback();
  assert.equal(
    f.service.call("operation", f.owner, {
      projectId: "project",
      operationId: "pending",
    }).state,
    "unknown",
  );
  assert.equal(writes, 1);
  assert.deepEqual(f.messages, []);
});

test("explicit lease renewal is bounded; reads do not renew and expired sockets cannot revive", async (t) => {
  let now = 1000;
  const f = await fixture(t, { service: { now: () => now, leaseMs: 30000 } });
  const target = await f.start();
  const initial = f.service.call("get", f.owner, target);
  now += 10000;
  assert.equal(
    f.service.call("get", f.owner, target).leaseUntil,
    initial.leaseUntil,
  );
  const renewed = f.service.call("renew", f.owner, target);
  assert.equal(Date.parse(renewed.leaseUntil), now + 30000);
  assert.equal(renewed.absoluteUntil, initial.absoluteUntil);
  now = Date.parse(initial.absoluteUntil) - 1000;
  // Explicit renew before expiry cannot jump an expired lease forward.
  assert.throws(() => f.service.call("renew", f.owner, target), /ended/);
  assert.equal(
    f.service.call("get", f.owner, target).ownershipCloseReason,
    "mcp-lease-expired",
  );
  await wait(() => f.server.clients.size === 0);
});

test("renew cannot extend the fifteen-minute absolute bound and event pages stay bounded", async (t) => {
  let now = 1000;
  const f = await fixture(t, { service: { now: () => now, leaseMs: 30000 } });
  const target = await f.start();
  const absolute = Date.parse(
    f.service.call("get", f.owner, target).absoluteUntil,
  );
  while (now + 29000 < absolute) {
    now += 29000;
    assert(
      Date.parse(f.service.call("renew", f.owner, target).leaseUntil) <=
        absolute,
    );
  }
  const finalLease = f.service.call("renew", f.owner, target);
  assert.equal(Date.parse(finalLease.leaseUntil), absolute);
  const session = f.sessions.get(target.sessionId);
  for (let i = 0; i < 205; i++)
    f.sessions.event(session, "received", "x".repeat(5000));
  const page = f.service.call("get", f.owner, { ...target, limit: 2 });
  assert.equal(page.events.length, 2);
  assert(page.droppedBeforePage >= 5);
  assert(page.hasMore);
  for (const event of page.events) {
    assert.equal(event.data.length, 4096);
    assert.equal(event.dataBytes, 5000);
    assert.equal(event.truncated, true);
    assert.equal(event.dataHash.length, 64);
  }
  now = absolute;
  assert.throws(() => f.service.call("renew", f.owner, target), /ended/);
  await wait(() => f.server.clients.size === 0);
});

test("short lease physically closes without polling or another tool call", async (t) => {
  const f = await fixture(t, { service: { leaseMs: 80 } });
  const target = await f.start();
  await wait(() => f.server.clients.size === 0);
  assert.equal(f.sessions.get(target.sessionId).closeReason, "deadline");
  assert.throws(() => f.service.call("renew", f.owner, target), /ended/);
});

test("MCP and owner connections consume the same five-slot pool; full ledger never evicts replay protection", async (t) => {
  const f = await fixture(t, { service: { maxOperations: 2 } });
  for (let n = 0; n < 4; n++)
    f.sessions.start({ type: "websocket", url: f.project.protocols[0].url });
  const target = await f.start();
  await wait(() => f.connections() === 5);
  const denied = await f.service.call("start", f.owner, {
    ...f.startArgs,
    operationId: "full-pool",
  });
  assert.equal(denied.state, "unknown");
  assert.match(denied.error, /No automatic network retry/);
  assert.throws(
    () =>
      f.service.call("start", f.owner, {
        ...f.startArgs,
        operationId: "full-ledger",
      }),
    /ledger is full/,
  );
  assert.equal(
    (await f.service.call("start", f.owner, f.startArgs)).sessionId,
    target.sessionId,
  );
  assert.equal(
    f.service.call("get", f.owner, target).sessionId,
    target.sessionId,
  );
  await f.service.call("stop", f.owner, target);
  await delay(10);
  assert.equal(f.connections(), 5);
});

test("stop and ownership disposal drain pending evidence without claiming storage success or resending", async (t) => {
  let release;
  let saves = 0;
  const f = await fixture(t, {
    onFinish(session) {
      saves++;
      session.recordPending = true;
      return new Promise((resolve) => {
        release = () => {
          session.recordPending = false;
          session.receipt = {
            recordSaved: false,
            recordPending: false,
            error: "storage outcome unknown",
          };
          resolve(session.receipt);
        };
      });
    },
  });
  const target = await f.start();
  let done = false;
  const stopped = f.service.call("stop", f.owner, target).then((value) => {
    done = true;
    return value;
  });
  await delay(10);
  assert.equal(done, false);
  f.registry.delete(f.httpId);
  let drained = false;
  const drain = f.registry.drain().then(() => {
    drained = true;
  });
  await delay(10);
  assert.equal(drained, false);
  release();
  const result = await stopped;
  await drain;
  assert.equal(result.recordSaved, false);
  assert.match(result.error, /unknown/);
  assert.equal(saves, 1);
  assert.equal(f.connections(), 1);
});

test("project revocation drains matching evidence and pending start without closing another project", async (t) => {
  let releaseSave;
  let releaseRead;
  const f = await fixture(t, {
    onFinish(session) {
      if (session.projectId !== "project") return;
      session.recordPending = true;
      return new Promise((resolve) => {
        releaseSave = () => {
          session.recordPending = false;
          session.recordSaved = true;
          session.receipt = { recordSaved: true };
          resolve(session.receipt);
        };
      });
    },
  });
  const other = { ...structuredClone(f.project), id: "other" };
  let reads = 0;
  f.service.store = {
    get: async (id) => {
      if (id === "other") return other;
      if (++reads === 2)
        return new Promise((resolve) => {
          releaseRead = resolve;
        });
      return f.project;
    },
  };
  const target = await f.start();
  const second = await f.service.call("start", f.owner, {
    ...f.startArgs,
    projectId: "other",
    operationId: "other-start",
  });
  assert.equal(second.state, "started");
  await wait(() => f.sessions.get(second.sessionId).state === "open");
  const pending = f.service.call("start", f.owner, {
    ...f.startArgs,
    operationId: "pending-start",
  });
  let drained = false;
  const revoke = f.service.revokeProject("project").then(() => {
    drained = true;
  });
  assert.throws(() => f.service.call("get", f.owner, target), /revoked/);
  assert.throws(
    () =>
      f.service.call("send", f.owner, {
        ...target,
        operationId: "revoked-send",
        message: "forbidden",
      }),
    /revoked/,
  );
  await delay(10);
  assert.equal(drained, false);
  releaseRead(f.project);
  assert.equal((await pending).state, "failed-before-submit");
  await delay(5);
  assert.equal(drained, false);
  releaseSave();
  await revoke;
  await wait(() => f.server.clients.size === 1);
  assert.equal(f.sessions.get(target.sessionId).state, "closed");
  const remaining = { projectId: "other", sessionId: second.sessionId };
  await f.service.call("send", f.owner, {
    ...remaining,
    operationId: "other-send",
    message: "still-active",
  });
  await wait(() => f.messages.length === 1);
  assert.deepEqual(f.messages, ["still-active"]);
  assert.equal(f.service.call("get", f.owner, remaining).state, "open");
  assert.equal(f.connections(), 2);
});

test("unknown definitions, script behavior, gRPC and temporary targets make no connections", async (t) => {
  const f = await fixture(t);
  for (const [operationId, definitionId] of [
    ["missing", "unknown"],
    ["script", "script"],
    ["grpc", "grpc"],
  ]) {
    if (definitionId === "script")
      f.project.protocols.push({
        ...f.project.protocols[0],
        id: "script",
        preScript: "fetch('https://example.invalid')",
      });
    if (definitionId === "grpc")
      f.project.protocols.push({
        id: "grpc",
        type: "grpc",
        url: f.project.protocols[0].url,
      });
    const result = await f.service.call("start", f.owner, {
      ...f.startArgs,
      operationId,
      definitionId,
    });
    assert.equal(result.state, "failed-before-submit");
  }
  // The finite-capture sendEmptyMessage policy is deliberately outside this
  // interactive slice, even when explicitly false. Do not silently drop it.
  for (const sendEmptyMessage of [true, false]) {
    const definitionId = `empty-policy-${sendEmptyMessage}`;
    f.project.protocols.push({
      ...f.project.protocols[0],
      id: definitionId,
      message: "",
      sendEmptyMessage,
    });
    const result = await f.service.call("start", f.owner, {
      ...f.startArgs,
      definitionId,
      operationId: definitionId,
    });
    assert.equal(result.state, "failed-before-submit");
  }
  for (const extra of [
    { url: f.project.protocols[0].url },
    { type: "websocket" },
    { headers: {} },
    { owner: "forged" },
  ]) {
    assert.throws(
      () => f.service.call("start", f.owner, { ...f.startArgs, ...extra }),
      /Unsupported/,
    );
  }
  assert.equal(f.connections(), 0);
  assert.equal(f.sessions.sessions.size, 0);
});

test("malformed, oversized and non-text messages are rejected before ledger or network submission", async (t) => {
  const f = await fixture(t);
  const target = await f.start();
  for (const message of [
    "\ud800",
    "x".repeat(1048577),
    "中".repeat(349526),
    { encoding: "utf8", data: "not-supported" },
    null,
  ]) {
    assert.throws(
      () =>
        f.service.call("send", f.owner, {
          ...target,
          operationId: "same-valid-id",
          message,
        }),
      /bounded well-formed text/,
    );
  }
  assert.throws(
    () =>
      f.service.call("operation", f.owner, {
        projectId: "project",
        operationId: "same-valid-id",
      }),
    /does not belong/,
  );
  await delay(10);
  assert.deepEqual(f.messages, []);
  assert.equal(
    f.sessions
      .get(target.sessionId)
      .events.filter((event) => event.direction === "sent").length,
    0,
  );
  await f.service.call("send", f.owner, {
    ...target,
    operationId: "same-valid-id",
    message: "valid",
  });
  await wait(() => f.messages.length === 1);
  assert.deepEqual(f.messages, ["valid"]);
});

test("project revocation skips discarded saved history and still closes and drains live connections", async (t) => {
  let saves = 0;
  let release;
  const f = await fixture(t, {
    onFinish(session) {
      saves++;
      if (saves === 1) {
        session.recordSaved = true;
        session.receipt = { recordSaved: true };
        return Promise.resolve(session.receipt);
      }
      session.recordPending = true;
      return new Promise((resolve) => {
        release = () => {
          session.recordSaved = true;
          session.recordPending = false;
          session.receipt = { recordSaved: true };
          resolve(session.receipt);
        };
      });
    },
  });
  const historic = await f.start("historic");
  assert.equal(
    (await f.service.call("stop", f.owner, historic)).recordSaved,
    true,
  );
  const historicSession = f.sessions.get(historic.sessionId);
  assert.equal(f.sessions.discard(historicSession), true);
  assert.equal(f.sessions.sessions.has(historic.sessionId), false);
  const live = await f.start("live");
  let drained = false;
  const pending = f.service.revokeProject("project").then(() => {
    drained = true;
  });
  assert.equal(f.sessions.get(live.sessionId).state, "closed");
  await wait(() => f.server.clients.size === 0);
  assert.equal(saves, 2);
  assert.equal(drained, false);
  release();
  await pending;
  assert.equal(drained, true);
  assert.equal(f.sessions.get(live.sessionId).recordSaved, true);
  assert.equal(f.connections(), 2);
});
