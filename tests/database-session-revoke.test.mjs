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
        peer.phase = sql === "START TRANSACTION" ? "start" : "setup";
        peer.release = () => ok(1);
        if (stage !== peer.phase) ok(1);
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
for (const type of ["postgres", "mysql"]) {
  for (const stage of type === "mysql"
    ? ["handshake", "setup", "start", "query"]
    : ["handshake", "setup", "query"]) {
    test(
      `${type} session revoke at ${stage} closes only captured grant and sends no later command`,
      { timeout: 8000 },
      async (t) => {
        const f = await fixture(t, type, stage),
          sessions = new DatabaseSessions();
        const a = sessions.register("a", { ...f.input, name: "a" }),
          b = sessions.register("b", { ...f.input, name: "b" });
        const cleanup = new AbortController();
        t.after(() => {
          cleanup.abort();
          sessions.close();
        });
        const qa = settle(
          sessions.query(
            "a",
            { connectionId: a.id, sql: "SELECT 1" },
            cleanup.signal,
          ),
        );
        await until(() => f.peers[0]?.phase === stage, "first held phase");
        const qb = settle(
          sessions.query(
            "b",
            { connectionId: b.id, sql: "SELECT 1" },
            cleanup.signal,
          ),
        );
        await until(() => f.peers[1]?.phase === stage, "second held phase");
        const count = f.records.length;
        sessions.revoke("a", a.id);
        await until(
          () => qa.done && f.closed.has(f.peers[0]),
          "revocation must close actual transport",
          750,
        );
        assert.match(qa.error?.message || "", /撤销/);
        assert.equal(qb.done, false);
        assert.equal(f.closed.has(f.peers[1]), false);
        f.peers[0].release();
        await delay(25);
        assert.equal(f.records.length, count);
        cleanup.abort();
        await Promise.all([qa.promise, qb.promise]);
      },
    );
  }
}
for (const held of ["AUTH", "SELECT"]) {
  for (const action of ["revoke", "close"]) {
    test(
      `Redis ${action} during ${held} closes both same-grant reads without GET`,
      { timeout: 5000 },
      async (t) => {
        const sockets = [],
          closed = new Set(),
          commands = [];
        const server = net.createServer((socket) => {
          sockets.push(socket);
          socket.on("error", () => {});
          socket.on("close", () => closed.add(socket));
          let pending = Buffer.alloc(0);
          socket.on("data", (bytes) => {
            pending = Buffer.concat([pending, bytes]);
            for (;;) {
              const item = parseRESP(pending);
              if (!item) break;
              pending = pending.subarray(item.bytes);
              commands.push(item.value[0].toString());
              if (held === "SELECT" && item.value[0].toString() === "AUTH")
                socket.write("+OK\r\n");
            }
          });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const sessions = new DatabaseSessions(),
          cleanup = new AbortController();
        t.after(async () => {
          cleanup.abort();
          sessions.close();
          for (const socket of sockets) socket.destroy();
          await new Promise((r) => server.close(r));
        });
        const config = {
          name: "fictional",
          type: "redis",
          host: "127.0.0.1",
          port: server.address().port,
          user: "fictional",
          password: "fictional",
          database: "1",
        };
        const a = sessions.register("p", config);
        const reads = [0, 1].map(() =>
          settle(
            sessions.query(
              "p",
              { connectionId: a.id, sql: '["GET","fixture"]' },
              cleanup.signal,
            ),
          ),
        );
        await until(
          () => commands.filter((x) => x === held).length === 2,
          "two held real frames",
        );
        if (action === "close") sessions.close();
        else sessions.revoke("p", a.id);
        await until(
          () => reads.every((r) => r.done) && closed.size === 2,
          "both revoked reads must close",
          750,
        );
        for (const r of reads) assert.match(r.error?.message || "", /撤销/);
        for (const socket of sockets)
          if (!socket.destroyed) socket.write("+OK\r\n");
        await delay(25);
        assert.equal(commands.filter((x) => x === held).length, 2);
        assert.equal(commands.includes("GET"), false);
        const fresh = sessions.register("p", config);
        assert.notEqual(fresh.id, a.id);
        assert.equal(sessions.list("p").length, 1);
      },
    );
  }
}

for (const heldStage of ["authentication", "forwarding"]) {
  test(
    `session revoke during SSH ${heldStage} returns owned transport capacity`,
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
        held = [],
        forwarded = [];
      const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
        clients.add(client);
        client.on("error", () => {});
        client.once("close", () => clients.delete(client));
        client.on("authentication", (ctx) => {
          if (ctx.method !== "password") {
            ctx.reject();
            return;
          }
          if (heldStage === "authentication") held.push(ctx);
          else ctx.accept();
        });
        client.on("tcpip", (accept, reject) => {
          forwarded.push({ accept, reject });
          if (heldStage === "forwarding") held.push({ accept, reject });
          else reject();
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const sessions = new DatabaseSessions();
      t.after(async () => {
        sessions.close();
        for (const c of clients) c.end();
        await new Promise((r) => server.close(r));
      });
      const config = {
        name: "fictional",
        type: "postgres",
        host: "127.0.0.1",
        port: 5432,
        user: "fictional",
        password: "",
        database: "fixture",
        ssh: {
          host: "127.0.0.1",
          port: server.address().port,
          username: "fictional",
          password: "fictional",
          hostKeySHA256: pin,
        },
      };
      const ids = Array.from(
        { length: 6 },
        () => sessions.register("p", config).id,
      );
      const reads = ids
        .slice(0, 5)
        .map((id) =>
          settle(sessions.query("p", { connectionId: id, sql: "SELECT 1" })),
        );
      await until(() => held.length === 5, "five held SSH operations", 4000);
      await assert.rejects(
        sessions.query("p", { connectionId: ids[5], sql: "SELECT 1" }),
        /最多5/,
      );
      sessions.revoke("p", ids[0]);
      await until(
        () => reads[0].done && clients.size === 4,
        "revoked SSH resource closed",
        1500,
      );
      assert.match(reads[0].error.message, /撤销/);
      assert(reads.slice(1).every((r) => !r.done));
      const fresh = settle(
        sessions.query("p", { connectionId: ids[5], sql: "SELECT 1" }),
      );
      await until(
        () => held.length === 6,
        "closed SSH capacity reusable",
        1500,
      );
      sessions.close();
      await Promise.all([...reads, fresh].map((r) => r.promise));
      await until(
        () => clients.size === 0,
        "all revoked SSH transports closed",
      );
      for (const r of [...reads, fresh]) assert.match(r.error.message, /撤销/);
      if (heldStage === "authentication") assert.equal(forwarded.length, 0);
    },
  );
}
