import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import mysql from "mysql2";
import { createHash } from "node:crypto";
import {
  queryRemoteDatabase,
  remoteConnectionConfig,
} from "../src/remote-database.mjs";
import {
  mutateMySQL,
  mysqlWriteUsage,
  parseMySQLWrite,
} from "../src/mysql-write.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { MCPDatabaseGrants } from "../src/mcp-database-grants.mjs";
const base = {
  type: "mysql",
  host: "127.0.0.1",
  port: 1,
  user: "fixture",
  password: "fixture-only",
  database: "fixture",
  sql: "SELECT 1",
  allowWrite: true,
};
const sanitized = (error) => {
  assert.equal(error.message, "MySQL连接文本Unicode无效");
  return true;
};

test("MySQL malformed credentials and database reject before direct, TLS, SSH, parser or write-slot use", async (t) => {
  let attempts = 0;
  const trap = () => {
    attempts++;
    throw Error("unexpected resource");
  };
  t.mock.method(net.Socket.prototype, "connect", trap);
  t.mock.method(tls, "connect", trap);
  t.mock.method(
    workerThreads,
    "Worker",
    class {
      constructor() {
        trap();
      }
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (const char of ["\ud800", "\udfff"])
    for (const field of ["user", "password", "database"])
      for (const transport of [{}, { ssl: true }, { ssh: {} }]) {
        const input = { ...base, ...transport, [field]: `private-${char}` };
        assert.throws(() => remoteConnectionConfig(input), sanitized);
        await assert.rejects(queryRemoteDatabase(input), sanitized);
        const mutation = mutateMySQL({
          ...input,
          sql: "INSERT INTO entries(value) VALUES (1)",
        });
        assert.equal(mysqlWriteUsage().active, 0);
        await assert.rejects(mutation, sanitized);
      }
  for (const char of ["\ud800", "\udfff"])
    await assert.rejects(
      parseMySQLWrite(
        "INSERT INTO entries(value) VALUES (1)",
        `private-${char}`,
      ),
      /MySQL数据库名称无效/,
    );
  assert.equal(attempts, 0);
});

test("MySQL session rejects malformed text before authority creation, but keeps other providers and valid fields unchanged", async () => {
  const sessions = new DatabaseSessions();
  try {
    for (const field of ["user", "password", "database"])
      for (const ssh of [undefined, {}])
        assert.throws(
          () =>
            sessions.register("p", {
              ...base,
              name: "fixture",
              [field]: "private-\ud800",
              ...(ssh === undefined ? {} : { ssh }),
            }),
          sanitized,
        );
    assert.deepEqual(sessions.list("p"), []);
    for (const config of [
      { user: "用户🙂�", password: "密码🙂�", database: "库🙂�" },
      { user: "", password: "", database: "" },
      {},
    ]) {
      const input = {
        type: "mysql",
        name: "fixture",
        host: "127.0.0.1",
        ...config,
      };
      const result = sessions.register("p", input);
      assert(result.id);
    }
    assert.equal(sessions.list("p").length, 3);
    // Only the MySQL admission policy changes; other providers retain their
    // own later query checks rather than acquiring a MySQL rule here.
    assert(
      sessions.register("p", {
        type: "redis",
        name: "fixture",
        password: "private-\ud800",
      }).id,
    );
  } finally {
    await sessions.close();
  }
  for (const value of [undefined, "", "中文🙂�", "\0"]) {
    const input = {
      type: "mysql",
      user: value,
      password: value,
      database: value,
    };
    const config = remoteConnectionConfig(input);
    for (const field of ["user", "password", "database"])
      assert.equal(config[field], value);
  }
});

const sha = (value) => createHash("sha1").update(value).digest();
function expectedToken(password, a, b) {
  const first = sha(password),
    second = sha(first),
    third = createHash("sha1")
      .update(a.subarray(0, 8))
      .update(b.subarray(0, 12))
      .update(second)
      .digest();
  return Buffer.from(first.map((value, index) => value ^ third[index]));
}
// An actual mysql2 handshake, not a database/authentication service. No raw
// credentials or auth tokens are returned or logged; retain only equality flags.
async function handshakePeer(t, expected) {
  const server = mysql.createServer(),
    sockets = [],
    observations = [];
  server.on("connection", (connection) => {
    sockets.push(connection.stream);
    connection.on("error", () => {});
    connection.serverHandshake({
      protocolVersion: 10,
      serverVersion: "8.0-fixture",
      connectionId: 42,
      statusFlags: 2,
      characterSet: 45,
      capabilityFlags: 8 | 512 | 32768 | 524288,
      authCallback: (packet, done) => {
        observations.push({
          userExact: packet.user === expected.user,
          databaseExact: packet.database === expected.database,
          passwordExact: packet.authToken.equals(
            expectedToken(
              expected.password,
              packet.authPluginData1,
              packet.authPluginData2,
            ),
          ),
        });
        // Stop after the handshake. Do not claim actual service acceptance or
        // execute the SQL/write supplied by the application.
        done(null, { code: 1045, message: "fixture authentication stop" });
      },
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server._server.address().port, observations };
}

test("MySQL actual driver handshake preserves legal Unicode in read and explicit-write paths", async (t) => {
  const expected = { user: "用户🙂�", database: "库🙂�", password: "密码🙂�" };
  const fixture = await handshakePeer(t, expected);
  for (const write of [false, true]) {
    await assert.rejects(
      (write ? mutateMySQL : queryRemoteDatabase)({
        ...base,
        ...expected,
        port: fixture.port,
        sql: write ? "INSERT INTO entries(value) VALUES (1)" : "SELECT 1",
      }),
    );
    assert.deepEqual(fixture.observations.at(-1), {
      userExact: true,
      databaseExact: true,
      passwordExact: true,
    });
  }
  assert.equal(fixture.observations.length, 2);
  assert.equal(mysqlWriteUsage().active, 0);
});

test("MCP MySQL grants inherit rejection without issuing an ephemeral grant", () => {
  const grants = new MCPDatabaseGrants(() => ({
    enabled: true,
    write: true,
    execute: true,
    projects: ["p"],
  }));
  for (const field of ["user", "password", "database"])
    assert.throws(
      () =>
        grants.register(
          { id: "p" },
          {
            type: "mysql",
            name: "fixture",
            host: "127.0.0.1",
            user: "fixture",
            database: "fixture",
            [field]: "private-\udfff",
          },
        ),
      sanitized,
    );
  assert.deepEqual(grants.list("p"), []);
  grants.invalidate();
});
