import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
const tlsKey = await readFile(
  new URL("./fixtures/localhost.key", import.meta.url),
  "utf8",
);
const tlsCert = await readFile(
  new URL("./fixtures/localhost.crt", import.meta.url),
  "utf8",
);
import { Server } from "socket.io";
import {
  SocketIOSessions,
  normalizeSocketIODefinition,
} from "../src/socketio.mjs";
async function fixture(t, secure = false) {
  const server = secure
    ? https.createServer({
        key: tlsKey,
        cert: tlsCert,
        ca: tlsCert,
        requestCert: true,
        rejectUnauthorized: true,
      })
    : http.createServer();
  const io = new Server(server, { path: "/events/" });
  const nsp = io.of("/private");
  const seen = [];
  let socket;
  let connections = 0;
  nsp.use((s, next) =>
    s.handshake.auth.token === "fixture-token" ? next() : next(Error("denied")),
  );
  nsp.on("connection", (s) => {
    socket = s;
    connections++;
    s.emit("welcome", { value: "ready" });
    s.on("echo", (value, ack) => {
      seen.push(value);
      if (ack) ack(value);
      s.emit("reply", value);
    });
    s.on("no-ack", () => seen.push("side-effect"));
    s.on("multi", (a, b, ack) => ack(a, b, Buffer.from([1, 2, 3])));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => io.close(r)));
  return {
    definition: {
      id: "echo",
      name: "Socket.IO",
      url: `${secure ? "https://localhost" : "http://127.0.0.1"}:${server.address().port}/private`,
      path: "/events/",
    },
    seen,
    get socket() {
      return socket;
    },
    get connections() {
      return connections;
    },
  };
}
const wait = async (fn) => {
  for (let i = 0; i < 200; i++) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("fixture condition timeout");
};
test("Socket.IO real namespace auth, bounded WebSocket transport, event and binary acknowledgments close without shared state", async (t) => {
  const f = await fixture(t);
  const sessions = new SocketIOSessions();
  t.after(() => sessions.close());
  const start = sessions.start("a", {
    ...f.definition,
    auth: { token: "fixture-token" },
  });
  await wait(() => sessions.snapshot("a", start.id).state === "open");
  const ack = await sessions.send("a", start.id, {
    event: "echo",
    args: [{ hello: "world" }],
    ackTimeoutMs: 1000,
  });
  assert.equal(ack.status, "acknowledged");
  assert.deepEqual(ack.args, [{ hello: "world" }]);
  const binary = await sessions.send("a", start.id, {
    event: "echo",
    args: [{ $binary: "AAEC/w==" }],
    ackTimeoutMs: 1000,
  });
  assert.equal(binary.args[0].$binary, "AAEC/w==");
  assert(Buffer.isBuffer(f.seen[1]));
  const multi = await sessions.send("a", start.id, {
    event: "multi",
    args: ["one", { two: 2 }],
    ackTimeoutMs: 1000,
  });
  assert.deepEqual(multi.args, ["one", { two: 2 }, { $binary: "AQID" }]);
  await wait(() =>
    sessions.snapshot("a", start.id).events.some((e) => e.event === "reply"),
  );
  assert.throws(() => sessions.snapshot("b", start.id), /项目|会话/);
  assert.throws(() => sessions.stop("b", start.id), /项目|会话/);
  const snap = sessions.stop("a", start.id);
  assert.equal(snap.state, "closed");
  assert(!JSON.stringify(snap).includes("fixture-token"));
  await assert.rejects(
    sessions.send("a", start.id, { event: "echo", args: [{}] }),
  );
});
test("Socket.IO timeout retains uncertain outcome and never retries; server-requested ack is explicit and one-use", async (t) => {
  const f = await fixture(t);
  const sessions = new SocketIOSessions();
  t.after(() => sessions.close());
  const s = sessions.start("a", {
    ...f.definition,
    auth: { token: "fixture-token" },
  });
  await wait(() => sessions.snapshot("a", s.id).state === "open");
  const result = await sessions.send("a", s.id, {
    event: "no-ack",
    args: [],
    ackTimeoutMs: 50,
  });
  assert.equal(result.status, "ack-timeout");
  assert.equal(result.remoteOutcome, "unknown");
  assert.deepEqual(f.seen, ["side-effect"]);
  const response = new Promise((resolve) =>
    f.socket.emit("question", { q: 1 }, resolve),
  );
  const incoming = await wait(() =>
    sessions.snapshot("a", s.id).events.find((e) => e.event === "question"),
  );
  assert(incoming.ackId);
  sessions.acknowledge("a", s.id, {
    ackId: incoming.ackId,
    args: [{ answer: 2 }],
  });
  assert.deepEqual(await response, { answer: 2 });
  assert.throws(() =>
    sessions.acknowledge("a", s.id, { ackId: incoming.ackId, args: [] }),
  );
  f.socket.disconnect(true);
  await wait(() => sessions.snapshot("a", s.id).state === "closed");
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(f.connections, 1);
});
test("Socket.IO rejects insecure overrides, reserved events, oversized data and failed authentication truthfully", async (t) => {
  const f = await fixture(t);
  const sessions = new SocketIOSessions();
  t.after(() => sessions.close());
  for (const input of [
    { ...f.definition, url: "http://user:pass@localhost" },
    { ...f.definition, tls: { rejectUnauthorized: false } },
    { ...f.definition, reconnection: true },
    { ...f.definition, transport: "unsupported" },
  ])
    assert.throws(() => sessions.start("a", input));
  assert.throws(() =>
    normalizeSocketIODefinition({
      ...f.definition,
      auth: { token: "never-save" },
    }),
  );
  const denied = sessions.start("a", f.definition);
  await wait(() => sessions.snapshot("a", denied.id).state === "error");
  assert.equal(f.connections, 0);
  const good = sessions.start("a", {
    ...f.definition,
    auth: { token: "fixture-token" },
  });
  await wait(() => sessions.snapshot("a", good.id).state === "open");
  for (const message of [
    { event: "disconnect", args: [] },
    { event: "echo", args: ["x".repeat(1024 * 1024 + 1)] },
    { event: "echo", args: [{ $binary: "***" }] },
  ])
    await assert.rejects(sessions.send("a", good.id, message));
  assert.equal(f.seen.length, 0);
});

test("Socket.IO HTTP project APIs persist definitions and final evidence, isolate projects and retry storage only", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { Store } = await import("../src/runtime.mjs");
  const { restoreProject } = await import("../src/core.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = await fixture(t),
    root = await mkdtemp(join(tmpdir(), "socketio-api-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("socket"),
    other = await app.store.create("other");
  const base = app.url + "/api/projects/" + p.id,
    headers = {
      "content-type": "application/json",
      "x-local-token": app.token,
    };
  const post = async (action, data, override = {}) =>
    fetch(base + "/" + action, {
      method: "POST",
      headers: { ...headers, ...override },
      body: JSON.stringify(data),
    });
  assert.equal(
    (
      await post("socketio-definitions", f.definition, {
        Origin: "https://untrusted.example",
      })
    ).ok,
    false,
  );
  const saved = await (await post("socketio-definitions", f.definition)).json();
  assert.equal(saved.definition.id, "echo");
  const before = await app.store.get(p.id);
  const session = await (
    await post("socketio-sessions", {
      definitionId: "echo",
      auth: { token: "fixture-token" },
    })
  ).json();
  const get = async () =>
    await (
      await fetch(base + "/socketio-sessions/" + session.id, { headers })
    ).json();
  let state;
  for (let i = 0; i < 100; i++) {
    state = await get();
    if (state.state === "open") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(state.state, "open");
  const foreign = await fetch(
    app.url + "/api/projects/" + other.id + "/socketio-sessions/" + session.id,
    { headers },
  );
  assert.equal(foreign.ok, false);
  const sent = await (
    await post("socketio-sessions/" + session.id + "/send", {
      event: "echo",
      args: [{ from: "api" }],
      ackTimeoutMs: 1000,
    })
  ).json();
  assert.equal(sent.status, "acknowledged");
  assert.equal(f.seen.length, 1);
  const append = app.store.append.bind(app.store);
  let fail = true;
  app.store.append = async (...args) => {
    if (args[1] === "protocolRuns" && fail) {
      fail = false;
      throw Error("fixture storage failure");
    }
    return append(...args);
  };
  const failed = await (
    await post("socketio-sessions/" + session.id + "/stop", {})
  ).json();
  assert.equal(failed.recordSaved, false);
  assert.equal(failed.persistenceOutcome.code, "RECORD_SAVE_FAILED");
  assert.doesNotMatch(failed.persistenceError, /fixture storage failure/);
  assert.equal(failed.state, "closed");
  const [a, b] = await Promise.all([
    post("socketio-sessions/" + session.id + "/stop", {}),
    post("socketio-sessions/" + session.id + "/stop", {}),
  ]);
  assert.equal((await a.json()).recordSaved, true);
  assert.equal((await b.json()).recordSaved, true);
  assert.equal(f.seen.length, 1);
  before.name = "changed";
  await app.store.save(before);
  const reloaded = await new Store(root).get(p.id);
  assert.equal(reloaded.protocolRuns.length, 1);
  assert.equal(reloaded.protocolRuns[0].type, "socketio");
  assert(
    reloaded.protocolRuns[0].result.events.some(
      (e) => e.direction === "acknowledged",
    ),
  );
  assert(!JSON.stringify(reloaded).includes("fixture-token"));
  const restored = restoreProject({ ...reloaded, version: 1 });
  await app.store.save(restored);
  assert.equal(
    (await app.store.get(restored.id)).protocolRuns[0].id,
    session.id,
  );
  const rejected = await post("socketio-definitions", {
    ...f.definition,
    auth: { token: "must-not-save" },
  });
  assert.equal(rejected.ok, false);
});
test("Socket.IO enforces active limits, explicit watch filters and bounded retained history", async (t) => {
  const f = await fixture(t),
    sessions = new SocketIOSessions();
  t.after(() => sessions.close());
  const active = Array.from({ length: 5 }, () =>
    sessions.start("a", { ...f.definition, auth: { token: "fixture-token" } }),
  );
  assert.throws(() => sessions.start("b", f.definition), /5个/);
  await wait(() => sessions.snapshot("a", active[0].id).state === "open");
  sessions.stop("a", active[0].id);
  const fresh = sessions.start("b", {
    ...f.definition,
    auth: { token: "fixture-token" },
  });
  await wait(() => sessions.snapshot("b", fresh.id).state === "open");
  sessions.watch("b", fresh.id, ["reply"]);
  await sessions.send("b", fresh.id, {
    event: "echo",
    args: ["watched"],
    ackTimeoutMs: 1000,
  });
  await wait(() =>
    sessions.snapshot("b", fresh.id).events.some((e) => e.event === "reply"),
  );
  const snapshot = sessions.snapshot("b", fresh.id);
  snapshot.events.length = 0;
  assert(sessions.snapshot("b", fresh.id).events.length > 0);
  sessions.watch("b", fresh.id, []);
  const before = sessions
    .snapshot("b", fresh.id)
    .events.filter((e) => e.direction === "received").length;
  await sessions.send("b", fresh.id, {
    event: "echo",
    args: ["hidden"],
    ackTimeoutMs: 1000,
  });
  assert.equal(
    sessions
      .snapshot("b", fresh.id)
      .events.filter((e) => e.direction === "received").length,
    before,
  );
  for (let i = 0; i < 205; i++)
    await sessions.send("b", fresh.id, {
      event: "echo",
      args: [i],
      ackTimeoutMs: 1000,
    });
  const history = sessions.snapshot("b", fresh.id);
  assert.equal(history.events.length, 200);
  assert.equal(history.truncated, true);
});

test("Socket.IO preserves TLS verification and mTLS, drops closed transports and bounds received frames", async (t) => {
  const f = await fixture(t, true),
    sessions = new SocketIOSessions();
  t.after(() => sessions.close());
  const denied = sessions.start("a", {
    ...f.definition,
    auth: { token: "fixture-token" },
    connectTimeoutMs: 1000,
  });
  await wait(() => sessions.snapshot("a", denied.id).state === "error");
  assert.equal(f.connections, 0);
  const good = sessions.start("a", {
    ...f.definition,
    auth: { token: "fixture-token" },
    tls: { ca: tlsCert, key: tlsKey, cert: tlsCert },
  });
  await wait(() => sessions.snapshot("a", good.id).state === "open");
  assert.equal(
    (
      await sessions.send("a", good.id, {
        event: "echo",
        args: ["secure"],
        ackTimeoutMs: 1000,
      })
    ).status,
    "acknowledged",
  );
  f.socket.emit("oversized", "x".repeat(1024 * 1024 + 1));
  await wait(() => sessions.snapshot("a", good.id).state === "error");
  assert.equal(sessions.get("a", good.id).socket, null);
  const result = sessions.snapshot("a", good.id);
  assert(!JSON.stringify(result).includes("BEGIN PRIVATE KEY"));
  assert(!result.events.some((e) => e.event === "oversized"));
  assert.equal(f.connections, 1);
});

test("Socket.IO cumulative budget closes the transport and preserves explicit bounded truncation", async (t) => {
  const f = await fixture(t),
    sessions = new SocketIOSessions();
  t.after(() => sessions.close());
  const s = sessions.start("a", {
    ...f.definition,
    auth: { token: "fixture-token" },
  });
  await wait(() => sessions.snapshot("a", s.id).state === "open");
  for (let i = 0; i < 8 && sessions.snapshot("a", s.id).state === "open"; i++) {
    try {
      await sessions.send("a", s.id, {
        event: "echo",
        args: ["x".repeat(700000)],
        ackTimeoutMs: 1000,
      });
    } catch (error) {
      assert.match(error.message, /8MiB|不可发送/);
    }
  }
  const result = sessions.snapshot("a", s.id);
  assert.equal(result.state, "error");
  assert(result.bytes <= 8 * 1024 * 1024);
  assert.equal(result.truncated, true);
  assert(Buffer.byteLength(JSON.stringify(result.events)) <= 2 * 1024 * 1024);
  assert.equal(sessions.get("a", s.id).socket, null);
});
