import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { readFile } from "node:fs/promises";
import { channel } from "node:diagnostics_channel";
import { queryRemoteDatabase } from "../src/remote-database.mjs";

const cert = await readFile(
    new URL("./fixtures/localhost.crt", import.meta.url),
    "utf8",
  ),
  key = await readFile(new URL("./fixtures/localhost.key", import.meta.url)),
  secureContext = tls.createSecureContext({ cert, key });

async function bounded(promise, label, milliseconds = 1500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("TLS cancellation fixture deadline: " + label)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function postgresPacket(tag, payload) {
  const packet = Buffer.alloc(payload.length + 5);
  packet[0] = tag.charCodeAt(0);
  packet.writeInt32BE(payload.length + 4, 1);
  payload.copy(packet, 5);
  return packet;
}
function mysqlPacket(payload, sequence) {
  const packet = Buffer.alloc(payload.length + 4);
  packet.writeUIntLE(payload.length, 0, 3);
  packet[3] = sequence;
  payload.copy(packet, 4);
  return packet;
}
function mysqlGreeting() {
  // Independent wire fixture, including CLIENT_SSL and mysql_native_password.
  const capabilities = 512 | 2048 | 8192 | 32768 | 131072 | 524288,
    connectionId = Buffer.alloc(4),
    low = Buffer.alloc(2),
    high = Buffer.alloc(2);
  connectionId.writeUInt32LE(1);
  low.writeUInt16LE(capabilities & 65535);
  high.writeUInt16LE(capabilities >>> 16);
  return mysqlPacket(
    Buffer.concat([
      Buffer.from([10]),
      Buffer.from("8.0-fictional\0"),
      connectionId,
      Buffer.from("abcdefgh"),
      Buffer.from([0]),
      low,
      Buffer.from([45, 2, 0]),
      high,
      Buffer.from([21]),
      Buffer.alloc(10),
      Buffer.from("ijklmnopqrst\0"),
      Buffer.from("mysql_native_password\0"),
    ]),
    0,
  );
}
async function fixture(type, stage) {
  const peers = [],
    commands = [];
  let ready,
    fail,
    negotiations = 0,
    authenticated = 0,
    secureConnections = 0;
  const reached = new Promise((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  // Observe errors even if a fixture fails before the test starts awaiting it.
  reached.catch(() => {});
  const track = (socket) => {
    const peer = { socket, closed: false };
    peer.done = new Promise((resolve) => {
      socket.once("close", () => {
        peer.closed = true;
        resolve();
      });
    });
    socket.on("error", () => {});
    peers.push(peer);
    return socket;
  };
  const server = net.createServer((socket) => {
    const raw = track(socket);
    let buffer = Buffer.alloc(0);
    if (type === "mysql") raw.write(mysqlGreeting());
    const negotiate = (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        const length =
          type === "postgres"
            ? 8
            : buffer.length >= 4
              ? buffer.readUIntLE(0, 3) + 4
              : Infinity;
        if (buffer.length < length) return;
        if (type === "postgres") {
          assert.equal(buffer.readInt32BE(0), 8);
          assert.equal(buffer.readInt32BE(4), 80877103);
        } else {
          assert.equal(length, 36);
          assert(buffer.readUInt32LE(4) & 2048, "CLIENT_SSL is required");
        }
        negotiations++;
        raw.pause();
        raw.removeListener("data", negotiate);
        if (type === "postgres") raw.write("S");
        if (stage === "tls-handshake") {
          // Wait for actual TLS ClientHello bytes, not merely a TCP connection.
          if (buffer.length > length) ready();
          else raw.once("data", () => ready());
          raw.resume();
          return;
        }
        // MySQL SSLRequest and ClientHello can arrive in one TCP chunk.
        if (buffer.length > length) raw.unshift(buffer.subarray(length));
        const secure = track(
          new tls.TLSSocket(raw, { isServer: true, secureContext }),
        );
        secure.once("secure", () => secureConnections++);
        let bytes = Buffer.alloc(0),
          startup = false;
        secure.on("data", (chunk) => {
          try {
            bytes = Buffer.concat([bytes, chunk]);
            while (bytes.length) {
              const length =
                type === "postgres"
                  ? startup
                    ? bytes.length >= 5
                      ? bytes.readInt32BE(1) + 1
                      : Infinity
                    : bytes.length >= 4
                      ? bytes.readInt32BE(0)
                      : Infinity
                  : bytes.length >= 4
                    ? bytes.readUIntLE(0, 3) + 4
                    : Infinity;
              if (bytes.length < length) return;
              assert(length >= 4 && length <= 65536);
              const packet = bytes.subarray(0, length);
              bytes = bytes.subarray(length);
              if (!startup) {
                startup = true;
                authenticated++;
                if (type === "postgres") {
                  assert.equal(packet.readInt32BE(4), 196608);
                  secure.write(
                    Buffer.concat([
                      postgresPacket("R", Buffer.alloc(4)),
                      postgresPacket("Z", Buffer.from("I")),
                    ]),
                  );
                } else {
                  assert.equal(packet[3], 2);
                  secure.write(
                    mysqlPacket(Buffer.from([0, 0, 0, 2, 0, 0, 0]), 3),
                  );
                }
              } else {
                if (type === "postgres") {
                  assert.equal(packet[0], "Q".charCodeAt(0));
                  commands.push(packet.subarray(5, -1).toString());
                } else {
                  assert.equal(packet[4], 3); // COM_QUERY
                  commands.push(packet.subarray(5).toString());
                }
                // Deliberately do not acknowledge the transaction setup query.
                ready();
              }
            }
          } catch (error) {
            fail(error);
            secure.destroy();
          }
        });
      } catch (error) {
        fail(error);
        raw.destroy();
      }
    };
    raw.on("data", negotiate);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    reached,
    peers,
    commands,
    stats: () => ({ negotiations, authenticated, secureConnections }),
    async close() {
      for (const { socket } of peers) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

for (const type of ["postgres", "mysql"])
  for (const stage of ["tls-handshake", "tls-query"])
    test(
      `${type} cancellation during ${stage} closes its actual TLS transport before returning`,
      { timeout: 15000 },
      async () => {
        const target = await fixture(type, stage),
          controller = new AbortController(),
          clients = [],
          sockets = channel("net.client.socket");
        // Node's public diagnostic channel exposes sockets without reaching into
        // pg/mysql2 internals or patching their implementation/connection methods.
        const observe = ({ socket }) => {
          const client = { socket, closed: false };
          socket.once("close", () => {
            client.closed = true;
          });
          clients.push(client);
        };
        sockets.subscribe(observe);
        let settled = false;
        const operation = queryRemoteDatabase(
          {
            type,
            host: "localhost",
            port: target.port,
            user: "fictional",
            password: "",
            database: "fixture",
            sql: "SELECT 1",
            ssl: true,
            ca: cert,
          },
          { signal: controller.signal },
        ).then(
          (value) => {
            settled = true;
            return { value };
          },
          (error) => {
            settled = true;
            return { error };
          },
        );
        try {
          await bounded(
            Promise.race([
              target.reached,
              operation.then(({ error }) => {
                throw Error(
                  "Query finished before the intended TLS stage: " +
                    (error?.code || "success"),
                );
              }),
            ]),
            "reach " + stage,
            5000,
          );
          assert.equal(settled, false);
          assert.equal(target.stats().negotiations, 1);
          if (stage === "tls-query") {
            assert.equal(target.stats().secureConnections, 1);
            assert.equal(target.stats().authenticated, 1);
            assert.deepEqual(target.commands, [
              type === "postgres"
                ? "BEGIN READ ONLY"
                : "SET TRANSACTION READ ONLY",
            ]);
          } else {
            assert.equal(target.stats().authenticated, 0);
            assert.deepEqual(target.commands, []);
          }
          controller.abort();
          // Less than the SQL phase timeout: returning only at that timeout is
          // not a passing cancellation test. No production budget is enlarged.
          const { error } = await bounded(operation, "cancel settles");
          assert.equal(error?.code, "DATABASE_QUERY_CANCELLED");
          assert.equal(error?.name, "AbortError");
          assert(clients.length >= 1, "an actual client socket was observed");
          assert(
            clients.every((client) => client.closed && client.socket.destroyed),
          );
          await bounded(
            Promise.all(target.peers.map((peer) => peer.done)),
            "peer closes",
          );
          assert(target.peers.every((peer) => peer.closed));
          assert.equal(target.commands.length, stage === "tls-query" ? 1 : 0);
        } finally {
          controller.abort();
          sockets.unsubscribe(observe);
          for (const { socket } of clients) socket.destroy();
          await target.close();
          await bounded(operation, "fixture cleanup", 5000);
        }
      },
    );
