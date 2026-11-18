import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import tls from "node:tls";
import { existsSync, readFileSync } from "node:fs";
import { runDamengProcess } from "../src/dameng-process.mjs";

const built = existsSync(
  new URL(
    "../src/vendor/dameng-native/workbench-dameng-read" +
      (process.platform === "win32" ? ".exe" : ""),
    import.meta.url,
  ),
);
const fixture = (name) =>
  readFileSync(new URL("./fixtures/" + name, import.meta.url));
function frame(command, id, body, fields = () => {}) {
  const head = Buffer.alloc(64);
  head.writeInt32LE(id);
  head.writeInt16LE(command, 4);
  head.writeInt32LE(body.length, 6);
  fields(head);
  head[19] = head.subarray(0, 19).reduce((a, b) => a ^ b, 0);
  return Buffer.concat([head, body]);
}
function receive(socket, consume) {
  let pending = Buffer.alloc(0);
  const data = (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (
      pending.length >= 64 &&
      pending.length >= 64 + pending.readInt32LE(6)
    ) {
      const length = 64 + pending.readInt32LE(6);
      const packet = pending.subarray(0, length);
      pending = pending.subarray(length);
      if (consume(packet) === false) {
        socket.off("data", data);
        break;
      }
    }
  };
  socket.on("data", data);
}

for (const [title, mode, trusted, identity, requestCert, success] of [
  [
    "reads and rolls back with verified server TLS",
    5,
    true,
    false,
    false,
    true,
  ],
  ["rejects a mismatched CA before LOGIN", 5, false, false, false, false],
  [
    "requires a client identity for mutual TLS before LOGIN",
    1,
    true,
    false,
    false,
    false,
  ],
  [
    "rejects an unused client identity before LOGIN",
    5,
    true,
    true,
    false,
    false,
  ],
  ["reads and rolls back with verified mutual TLS", 1, true, true, true, true],
])
  test("native DM8 loopback " + title, { skip: !built }, async (t) => {
    const previous = process.env.LOCALAPI_DAMENG_PREVIEW;
    process.env.LOCALAPI_DAMENG_PREVIEW = "read-only";
    t.after(() => {
      if (previous === undefined) delete process.env.LOCALAPI_DAMENG_PREVIEW;
      else process.env.LOCALAPI_DAMENG_PREVIEW = previous;
    });
    const seen = [],
      binds = [];
    let handle = 0;
    const stmts = new Map();
    const secured = tls.createServer(
      {
        key: fixture("localhost.key"),
        cert: fixture("dameng-loopback.crt"),
        ca: fixture("localhost.crt"),
        requestCert,
        rejectUnauthorized: requestCert,
      },
      (socket) => {
        socket.on("error", () => {});
        if (requestCert) {
          assert.equal(socket.authorized, true);
          assert.equal(
            socket.getPeerCertificate().subject.CN,
            "workbench-dm8-test-reader",
          );
        }
        receive(socket, (packet) => {
          const command = packet.readInt16LE(4),
            id = packet.readInt32LE(0);
          seen.push(command);
          let body = Buffer.alloc(0),
            fields = () => {},
            replyId = id;
          if (command === 1) {
            assert.equal(packet[32], 1);
            assert(packet.includes(Buffer.from("synthetic-password")));
            body = Buffer.alloc(36);
          } else if (command === 3) replyId = ++handle;
          else if (command === 5) {
            const sql = packet.subarray(64).toString("utf8").replace(/\0$/, "");
            stmts.set(id, sql);
            if (sql !== "SET TRANSACTION READ ONLY") {
              assert.equal(
                sql,
                'SELECT TOP 1001 "N" FROM "APP"."ITEMS" WHERE "K" >= ? AND "K" <= ?',
              );
              const param = Buffer.alloc(32);
              param.writeInt32LE(8);
              const column = Buffer.alloc(33);
              column.writeInt32LE(8);
              column.writeInt16LE(1, 24);
              column[32] = 78;
              body = Buffer.concat([param, param, column]);
              fields = (h) => {
                h.writeInt16LE(160, 20);
                h.writeUInt16LE(2, 22);
                h.writeInt16LE(1, 24);
              };
            }
          } else if (
            command === 13 &&
            stmts.get(id) !== "SET TRANSACTION READ ONLY"
          ) {
            assert.equal(packet[20], 0);
            binds.push(
              packet.readBigInt64LE(packet.length - 18),
              packet.readBigInt64LE(packet.length - 8),
            );
            body = Buffer.alloc(22);
            body.writeUInt16LE(8, 12);
            body.writeBigInt64LE(9223372036854775807n, 14);
            fields = (h) => {
              h.writeInt16LE(160, 20);
              h.writeBigInt64LE(1n, 24);
              h.writeUInt32LE(1, 35);
            };
          } else
            assert.ok(
              [4, 9, 13].includes(command),
              "unexpected DM command " + command,
            );
          socket.write(frame(command, replyId, body, fields));
        });
      },
    );
    secured.on("tlsClientError", () => {});
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      receive(socket, (packet) => {
        assert.equal(packet.readInt16LE(4), 200);
        const version = Buffer.from("8.1.3.62"),
          prefix = Buffer.alloc(4);
        prefix.writeInt32LE(version.length);
        socket.write(
          frame(200, 0, Buffer.concat([prefix, version]), (h) => {
            h.writeInt32LE(mode, 20);
            h.writeInt32LE(1, 28);
            h.writeUInt16LE(6, 48);
          }),
        );
        secured.emit("connection", socket);
        return false;
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const query = runDamengProcess({
      connection: {
        host: "127.0.0.1",
        serverName: "127.0.0.1",
        port: server.address().port,
        user: "fixture",
        password: "synthetic-password",
        ssl: true,
        ...(identity && {
          clientCert: fixture("dameng-client.crt").toString(),
          clientKey: fixture("localhost.key").toString(),
        }),
        ca: fixture(
          trusted ? "localhost.crt" : "sqlserver-wrong-host.crt",
        ).toString(),
      },
      sql: "SELECT n FROM app.items WHERE k>=:p1 AND k<=:p0",
      parameters: [71, 19],
    });
    if (!success) {
      await assert.rejects(query, /NO_RESULT/);
      assert.deepEqual(seen, []);
      return;
    }
    assert.deepEqual((await query).rows, [{ N: "9223372036854775807" }]);
    assert.deepEqual(binds, [19n, 71n]);
    assert.deepEqual(seen.slice(0, 8), [1, 3, 5, 13, 3, 5, 13, 9]);
  });
