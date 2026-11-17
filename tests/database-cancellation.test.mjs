// Independent protocol peers exercise real drivers, not database query/rollback
// semantics. A closed local transport cannot prove a remote SQL engine stopped.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { once, getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createHash, generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import { querySQLiteBounded } from "../src/database.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { parseRESP } from "../src/redis.mjs";
import { createApp } from "../src/server.mjs";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, limit = 1500) {
  const end = Date.now() + limit;
  while (!(await predicate())) {
    assert(Date.now() < end, label);
    await delay(5);
  }
}
const settle = (promise) => {
  const state = { done: false };
  state.promise = promise.then(
    (value) => {
      state.done = true;
      state.value = value;
    },
    (error) => {
      state.done = true;
      state.error = error;
    },
  );
  return state;
};
const pgPacket = (tag, body) => {
  const packet = Buffer.alloc(body.length + 5);
  packet[0] = tag.charCodeAt(0);
  packet.writeUInt32BE(body.length + 4, 1);
  body.copy(packet, 5);
  return packet;
};
function pgPeer(socket, records, stage) {
  let buffer = Buffer.alloc(0),
    startup = false;
  const send = (bytes) => {
    if (!socket.destroyed) socket.write(bytes);
  };
  const ready = () =>
    send(
      Buffer.concat([
        pgPacket("R", Buffer.alloc(4)),
        pgPacket("Z", Buffer.from("I")),
      ]),
    );
  const ack = () =>
    send(
      Buffer.concat([
        pgPacket("C", Buffer.from("BEGIN\0")),
        pgPacket("Z", Buffer.from("T")),
      ]),
    );
  const peer = { socket, records, release: ready, phase: "connection" };
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      if (!startup) {
        if (buffer.length < 4 || buffer.length < buffer.readUInt32BE(0)) return;
        buffer = buffer.subarray(buffer.readUInt32BE(0));
        startup = true;
        peer.phase = "handshake";
        if (stage !== "handshake") ready();
        continue;
      }
      if (buffer.length < 5 || buffer.length < buffer.readUInt32BE(1) + 1)
        return;
      const size = buffer.readUInt32BE(1),
        tag = String.fromCharCode(buffer[0]),
        body = buffer.subarray(5, size + 1);
      buffer = buffer.subarray(size + 1);
      if (tag === "Q") {
        records.push(body.toString().replace(/\0$/, ""));
        peer.phase = "setup";
        peer.release = ack;
        if (stage !== "setup") ack();
      }
      if (tag === "P") {
        records.push(body.subarray(1).toString().split("\0")[0]);
        peer.phase = "query";
      }
      if (tag === "S" && peer.completeQuery) {
        send(
          Buffer.concat([
            pgPacket("1", Buffer.alloc(0)),
            pgPacket("2", Buffer.alloc(0)),
            pgPacket("n", Buffer.alloc(0)),
            pgPacket("C", Buffer.from("SELECT 0\0")),
            pgPacket("Z", Buffer.from("T")),
          ]),
        );
      }
    }
  });
  return peer;
}
const mysqlPacket = (body, sequence) => {
  const packet = Buffer.alloc(body.length + 4);
  packet.writeUIntLE(body.length, 0, 3);
  packet[3] = sequence;
  body.copy(packet, 4);
  return packet;
};
function mysqlPeer(socket, records, stage) {
  const flags = 512 | 32768 | 524288 | 8;
  const header = Buffer.alloc(4);
  header.writeUInt32LE(1);
  const low = Buffer.alloc(2);
  low.writeUInt16LE(flags & 65535);
  const tail = Buffer.alloc(16);
  tail[0] = 45;
  tail.writeUInt16LE(2, 1);
  tail.writeUInt16LE(flags >>> 16, 3);
  tail[5] = 21;
  const hello = Buffer.concat([
    Buffer.from([10]),
    Buffer.from("8.0-fixture\0"),
    header,
    Buffer.from("12345678\0"),
    low,
    tail,
    Buffer.from("123456789012\0mysql_native_password\0"),
  ]);
  const send = (bytes) => {
    if (!socket.destroyed) socket.write(bytes);
  };
  const ok = (sequence) =>
    send(mysqlPacket(Buffer.from([0, 0, 0, 2, 0, 0, 0]), sequence));
  let buffer = Buffer.alloc(0),
    authenticated = false;
  const peer = {
    socket,
    records,
    phase: "connection",
    release: () => send(mysqlPacket(hello, 0)),
  };
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUIntLE(0, 3);
      if (buffer.length < size + 4) return;
      const packet = buffer.subarray(4, size + 4);
      buffer = buffer.subarray(size + 4);
      if (!authenticated) {
        authenticated = true;
        peer.phase = "handshake";
        peer.release = () => ok(2);
        if (stage !== "handshake") ok(2);
        continue;
      }
      const command = packet[0],
        sql = packet.subarray(1).toString();
      if (command === 3) {
        records.push(sql);
        peer.phase = "setup";
        peer.release = () => ok(1);
        if (stage !== "setup") ok(1);
      }
      if (command === 22) {
        records.push(sql);
        peer.phase = "query";
      }
    }
  });
  if (stage !== "connection") peer.release();
  return peer;
}
async function fixture(t, type, stage = "handshake") {
  const peers = [],
    closed = new Set(),
    records = [];
  const server = net.createServer((socket) => {
    const peer = (type === "postgres" ? pgPeer : mysqlPeer)(
      socket,
      records,
      stage,
    );
    peers.push(peer);
    socket.once("close", () => closed.add(peer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const peer of peers) peer.socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const input = {
    type,
    host: "127.0.0.1",
    port: server.address().port,
    user: "fictional",
    password: "",
    database: "fixture",
    sql: "SELECT 1",
    ssl: false,
  };
  return { input, peers, closed, records };
}

test(
  "real PG/MySQL owned streams cancel handshake/setup/query, isolate projects and forbid late commands",
  { timeout: 20000 },
  async (t) => {
    for (const type of ["postgres", "mysql"]) {
      for (const stage of ["handshake", "setup", "query"]) {
        const f = await fixture(t, type, stage),
          sessions = new DatabaseSessions();
        const a = sessions.register("a", { ...f.input, name: "a" }),
          b = sessions.register("b", { ...f.input, name: "b" });
        const ca = new AbortController(),
          cb = new AbortController();
        const qa = settle(
          sessions.query(
            "a",
            { connectionId: a.id, sql: f.input.sql },
            ca.signal,
          ),
        );
        await until(
          () => f.peers[0]?.phase === stage,
          `${type} first ${stage}`,
        );
        const qb = settle(
          sessions.query(
            "b",
            { connectionId: b.id, sql: f.input.sql },
            cb.signal,
          ),
        );
        await until(
          () => f.peers[1]?.phase === stage,
          `${type} second ${stage}`,
        );
        const count = f.records.length;
        ca.abort();
        await until(
          () => qa.done && f.closed.has(f.peers[0]),
          `${type} must close on cancellation`,
        );
        await qa.promise;
        assert.match(qa.error?.message ?? "", /已取消/);
        assert(!qb.done);
        assert(!f.closed.has(f.peers[1]));
        f.peers[0].release();
        await delay(20);
        assert.equal(
          f.records.length,
          count,
          "late handshake/setup release must not queue SQL",
        );
        assert.equal(getEventListeners(ca.signal, "abort").length, 0);
        cb.abort();
        await until(
          () => qb.done && f.closed.has(f.peers[1]),
          "second operation cleanup",
        );
        await qb.promise;
        assert.match(qb.error?.message ?? "", /已取消/);
        sessions.close();
        const before = f.peers.length;
        await assert.rejects(
          queryRemoteDatabase(f.input, { signal: ca.signal }),
          /已取消/,
        );
        await delay(20);
        assert.equal(
          f.peers.length,
          before,
          "pre-aborted SQL must not connect",
        );
      }
    }
  },
);

test(
  "MySQL setup and PREPARE are bounded even without cancellation",
  { timeout: 10000 },
  async (t) => {
    for (const stage of ["setup", "query"]) {
      const f = await fixture(t, "mysql", stage),
        started = performance.now();
      await assert.rejects(queryRemoteDatabase(f.input), /超时|timeout/i);
      await until(
        () => f.closed.size === 1,
        "phase deadline must destroy the actual socket",
      );
      assert(
        performance.now() - started < 3500,
        "must not wait an unbounded SET/START/PREPARE",
      );
    }
  },
);

test(
  "Redis and ClickHouse cancellation closes actual sockets and prevents AUTH-followup",
  { timeout: 10000 },
  async (t) => {
    for (const type of ["redis", "clickhouse"]) {
      const sockets = [],
        closed = new Set(),
        seen = [];
      let release;
      const server =
        type === "redis"
          ? net.createServer((socket) => {
              sockets.push(socket);
              socket.on("error", () => {});
              socket.once("close", () => closed.add(socket));
              socket.on("data", (bytes) => {
                const args = parseRESP(bytes).value.map((value) =>
                  value.toString(),
                );
                seen.push(args[0]);
                release = () => {
                  if (!socket.destroyed) socket.write("+OK\r\n");
                };
              });
            })
          : http.createServer((_req, res) => {
              const socket = res.socket;
              sockets.push(socket);
              socket.once("close", () => closed.add(socket));
              seen.push("GET");
              release = () => {
                if (!res.destroyed) res.end('{"meta":[],"data":[]}');
              };
            });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      });
      const input = {
        type,
        host: "127.0.0.1",
        port: server.address().port,
        user: "fictional",
        password: "fictional",
        sql: type === "redis" ? '["GET","fixture"]' : "SELECT 1",
      };
      const controller = new AbortController(),
        operation = settle(
          queryRemoteDatabase(input, { signal: controller.signal }),
        );
      await until(
        () => seen.length === 1,
        "provider request did not reach actual peer",
      );
      controller.abort();
      await until(
        () => operation.done && closed.size === 1,
        "provider cancellation must close socket",
      );
      await operation.promise;
      assert.match(operation.error?.message ?? "", /已取消/);
      release();
      await delay(20);
      assert.equal(seen.length, 1);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      await assert.rejects(
        queryRemoteDatabase(input, { signal: controller.signal }),
        /已取消/,
      );
      await delay(20);
      assert.equal(sockets.length, 1);
    }
  },
);

test(
  "SQLite cancellation kills the real read process before its original deadline and never labels cancellation timeout",
  { timeout: 10000 },
  async (t) => {
    // Observe the actual child object, without substituting its SQL or kill method.
    const require = createRequire(import.meta.url),
      cp = require("node:child_process"),
      original = cp.fork;
    const children = [];
    cp.fork = (...args) => {
      const child = original(...args);
      children.push(child);
      return child;
    };
    syncBuiltinESMExports();
    const root = await mkdtemp(path.join(tmpdir(), "sqlite-read-cancel-")),
      filename = path.join(root, "fixture.sqlite");
    t.after(async () => {
      cp.fork = original;
      syncBuiltinESMExports();
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE fixture(value INTEGER)");
    db.close();
    const controller = new AbortController();
    const query = settle(
      querySQLiteBounded(
        filename,
        "WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c WHERE x<1000000000) SELECT sum(x) FROM c",
        [],
        { signal: controller.signal },
      ),
    );
    await until(
      () => children.length === 1 && Number.isInteger(children[0].pid),
      "actual child must spawn",
    );
    await delay(200);
    assert.equal(children[0].exitCode, null);
    controller.abort();
    await until(
      () => query.done,
      "SQLite must await actual child close, not original 2s timeout",
    );
    await query.promise;
    assert.match(query.error?.message ?? "", /已取消/);
    assert.equal(query.error?.code, "DATABASE_QUERY_CANCELLED");
    assert(children[0].exitCode !== null || children[0].signalCode !== null);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await assert.rejects(
      querySQLiteBounded(filename, "SELECT 1", [], {
        signal: controller.signal,
      }),
      /已取消/,
    );
    assert.equal(children.length, 1);
    assert.equal(
      (await querySQLiteBounded(filename, "SELECT 7 AS value")).rows[0].value,
      7,
    );
  },
);

test(
  "SSH cancellation releases pinned transport capacity without direct fallback or late forwarding",
  { timeout: 15000 },
  async (t) => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const pin =
      "SHA256:" +
      createHash("sha256")
        .update(ssh2.utils.parseKey(privateKey).getPublicSSH())
        .digest("base64")
        .replace(/=$/, "");
    const clients = new Set(),
      peers = [],
      peersByIdentity = new Map(),
      initialAuthentication = new Map(),
      heldAuthentication = [];
    let holdAuthentication = false;
    const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
      clients.add(client);
      client.on("error", () => {});
      let identity;
      const transportClosed = new Promise((resolve) =>
        client.once("close", () => {
          clients.delete(client);
          resolve();
        }),
      );
      client.on("authentication", (ctx) => {
        if (holdAuthentication) {
          heldAuthentication.push(ctx);
          return;
        }
        if (
          ctx.method === "password" &&
          (ctx.username === "fictional" ||
            /^fictional-[0-4]$/.test(ctx.username)) &&
          ctx.password === "fictional"
        ) {
          identity = ctx.username;
          if (identity !== "fictional")
            initialAuthentication.set(identity, ctx);
          else ctx.accept();
        } else ctx.reject();
      });
      client.on("tcpip", (accept) => {
        const peer = pgPeer(accept(), [], "handshake");
        Object.assign(peer, { identity, transportClosed });
        peers.push(peer);
        peersByIdentity.set(identity, peer);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      for (const client of clients) client.end();
      await new Promise((resolve) => server.close(resolve));
    });
    const input = {
      type: "postgres",
      host: "127.0.0.1",
      port: 5432,
      user: "fictional",
      password: "",
      database: "fixture",
      sql: "SELECT 1",
      ssh: {
        host: "127.0.0.1",
        port: server.address().port,
        username: "fictional",
        password: "fictional",
        hostKeySHA256: pin,
      },
    };
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const pending = controllers.map((controller, index) =>
      settle(
        queryRemoteDatabase(
          { ...input, ssh: { ...input.ssh, username: `fictional-${index}` } },
          { signal: controller.signal },
        ),
      ),
    );
    await until(
      () => initialAuthentication.size === 5,
      "five individually identified authentication gates",
      4000,
    );
    // Deterministically invert arrival order without relying on scheduler delays.
    for (const index of [4, 3, 2, 1, 0]) {
      const identity = `fictional-${index}`;
      initialAuthentication.get(identity).accept();
      await until(
        () => peersByIdentity.get(identity)?.phase === "handshake",
        "identified SSH channel reaches PostgreSQL handshake",
        4000,
      );
    }
    assert.deepEqual(
      peers.map((peer) => peer.identity),
      [4, 3, 2, 1, 0].map((i) => `fictional-${i}`),
    );
    const cancelledPeer = peersByIdentity.get("fictional-0");
    assert.notEqual(
      peers[0],
      cancelledPeer,
      "arrival index is not controller identity",
    );
    await until(
      () =>
        peers.length === 5 && peers.every((peer) => peer.phase === "handshake"),
      "five pinned SSH channels",
      4000,
    );
    await assert.rejects(queryRemoteDatabase(input), /最多5/);
    controllers[0].abort();
    await until(
      () => pending[0].done && clients.size === 4,
      "first SSH connection actually closed",
    );
    await cancelledPeer.transportClosed;
    cancelledPeer.release();
    assert.equal(cancelledPeer.records.length, 0);
    const nextController = new AbortController(),
      next = settle(
        queryRemoteDatabase(input, { signal: nextController.signal }),
      );
    await until(
      () => peers.length === 6,
      "closed lease permits replacement connection",
    );
    // The old index-based release would instead unblock this live invocation.
    // Let that separately identified peer finish: its wire SQL is a positive
    // control, while the cancelled peer must still have zero SQL afterward.
    const activePeer = peersByIdentity.get("fictional-4");
    activePeer.completeQuery = true;
    activePeer.release();
    await pending[4].promise;
    assert.equal(pending[4].error, undefined);
    assert.deepEqual(pending[4].value.rows, []);
    assert.equal(activePeer.records[0], "BEGIN READ ONLY");
    assert.match(activePeer.records[1], /SELECT.*localapi_result/s);
    assert.equal(
      cancelledPeer.records.length,
      0,
      "late release never sends SQL on the cancelled invocation",
    );
    nextController.abort();
    for (const controller of controllers) controller.abort();
    await Promise.all([...pending, next].map((item) => item.promise));
    await until(() => clients.size === 0, "all SSH transports close");
    for (const item of [...pending.slice(0, 4), next])
      assert.match(item.error?.message ?? "", /已取消/);
    holdAuthentication = true;
    const openingController = new AbortController();
    const opening = settle(
      queryRemoteDatabase(input, { signal: openingController.signal }),
    );
    await until(
      () => heldAuthentication.length === 1,
      "SSH authentication is held before forwarding",
    );
    const beforeOpening = peers.length;
    openingController.abort();
    // Release a racing response while the peer still exists, not after the
    // server has closed (ssh2 would start its own post-close keepalive timer).
    heldAuthentication[0].accept();
    await until(
      () => opening.done && clients.size === 0,
      "abort must close an opening SSH transport",
    );
    await opening.promise;
    assert.match(opening.error?.message ?? "", /已取消/);
    await delay(20);
    assert.equal(
      peers.length,
      beforeOpening,
      "late authentication must never forward after cancellation",
    );
    holdAuthentication = false;
    const before = peers.length;
    await assert.rejects(
      queryRemoteDatabase(input, { signal: nextController.signal }),
      /已取消/,
    );
    assert.equal(peers.length, before);
    await assert.rejects(
      queryRemoteDatabase({
        ...input,
        ssh: {
          ...input.ssh,
          hostKeySHA256:
            "SHA256:" + Buffer.alloc(32).toString("base64").replace(/=$/, ""),
        },
      }),
      /主机校验/,
    );
    assert.equal(
      peers.length,
      before,
      "wrong pin never opens a DB channel or falls back direct",
    );
  },
);

test(
  "direct project HTTP read disconnect closes its DB transport instead of waiting for handshake timeout",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, "postgres", "handshake"),
      root = await mkdtemp(path.join(tmpdir(), "http-read-cancel-")),
      app = await createApp({ root, port: 0 });
    t.after(async () => {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const p = await app.store.create("disconnect fixture");
    const request = http.request(app.url + `/api/projects/${p.id}/database`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
    });
    request.on("error", () => {});
    request.end(JSON.stringify(f.input));
    await until(
      () => f.peers[0]?.phase === "handshake",
      "HTTP read must reach actual driver",
    );
    request.destroy();
    await until(
      () => f.closed.size === 1,
      "disconnected HTTP read must close DB immediately",
    );
    assert.equal(f.records.length, 0);
    assert.deepEqual((await app.store.get(p.id)).runs, []);
  },
);
