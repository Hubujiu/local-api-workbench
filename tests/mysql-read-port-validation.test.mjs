import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import {
  remoteConnectionConfig,
  queryRemoteDatabase,
} from "../src/remote-database.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { mutateMySQL, mysqlWriteUsage } from "../src/mysql-write.mjs";
import { explicitPostgresOptions } from "../src/postgres-client.mjs";
const base = {
  type: "mysql",
  host: "127.0.0.1",
  user: "fixture",
  database: "fixture",
  sql: "SELECT 1",
};
const bad = [
  null,
  "not-a-port",
  false,
  true,
  {},
  [],
  [3306],
  NaN,
  Infinity,
  -Infinity,
  1.5,
  -1,
  65536,
  "3306.0",
  "3.306e3",
  "-1",
  "65536",
  " 3306 ",
  " ",
  "+3306",
  "0xcea",
];
test("MySQL read port rejects invalid inputs instead of coercing to another target", () => {
  for (const port of bad)
    assert.throws(
      () => remoteConnectionConfig({ ...base, port }),
      (e) => e.message === "MySQL端口无效",
    );
});
test("MySQL direct read preserves existing explicit default sentinels and decimal strings only", () => {
  for (const port of [undefined, 0, -0, "", "0", "000"])
    assert.equal(remoteConnectionConfig({ ...base, port }).port, 3306);
  for (const [port, expected] of [
    [1, 1],
    [65535, 65535],
    ["3306", 3306],
    ["003306", 3306],
    ["65535", 65535],
  ])
    assert.equal(remoteConnectionConfig({ ...base, port }).port, expected);
});
test("invalid MySQL read ports reject before direct or SSH transport construction", async () => {
  const originalConnect = net.Socket.prototype.connect,
    originalNetConnect = net.connect;
  let called = 0;
  net.Socket.prototype.connect = function () {
    called++;
    throw Error("transport must not start");
  };
  net.connect = () => {
    called++;
    throw Error("SSH transport must not start");
  };
  syncBuiltinESMExports();
  try {
    for (const port of bad)
      for (const ssh of [undefined, {}])
        await assert.rejects(
          queryRemoteDatabase({
            ...base,
            port,
            ...(ssh === undefined ? {} : { ssh }),
          }),
          (e) => e.message === "MySQL端口无效",
        );
    assert.equal(called, 0);
  } finally {
    net.Socket.prototype.connect = originalConnect;
    net.connect = originalNetConnect;
    syncBuiltinESMExports();
  }
});
test("normal read decimal strings select exactly that port and zero defaults remain direct-only", async () => {
  const original = net.Socket.prototype.connect;
  let seen;
  net.Socket.prototype.connect = function (...args) {
    seen = args;
    queueMicrotask(() => this.destroy());
    throw Error("probe prevents network");
  };
  try {
    for (const [port, expected] of [
      ["003306", 3306],
      ["65535", 65535],
      [0, 3306],
      ["0", 3306],
    ]) {
      seen = undefined;
      await assert.rejects(
        queryRemoteDatabase({ ...base, port }),
        /probe prevents network/,
      );
      assert.deepEqual(seen, [expected, "127.0.0.1"]);
    }
  } finally {
    net.Socket.prototype.connect = original;
  }
});
test("session write and PostgreSQL input contracts are not widened by read compatibility", async () => {
  const sessions = new DatabaseSessions();
  try {
    for (const port of [null, "0", "3306", false, true])
      assert.throws(
        () => sessions.register("p", { ...base, name: "fixture", port }),
        /端口/,
      );
    const grant = sessions.register("p", { ...base, name: "fixture", port: 0 });
    assert(grant.id);
  } finally {
    sessions.close();
  }
  for (const port of [null, 0, "0", "3306", false, true])
    await assert.rejects(
      mutateMySQL({
        ...base,
        allowWrite: true,
        port,
        sql: "INSERT INTO t VALUES (1)",
      }),
      /端口/,
    );
  assert.equal(mysqlWriteUsage().active, 0);
  for (const port of [null, false, true, "3306.0"])
    assert.throws(
      () => explicitPostgresOptions({ ...base, type: "postgres", port }),
      /端口/,
    );
  assert.equal(
    explicitPostgresOptions({ ...base, type: "postgres", port: 0 }).port,
    5432,
  );
  assert.equal(
    explicitPostgresOptions({ ...base, type: "postgres", port: "003306" }).port,
    3306,
  );
});

test("UI Number conversion cannot turn an invalid port into a default connection", async () => {
  // Mirrors public/app.js db-port Number(value), then API JSON serialization.
  for (const text of ["abc", "Infinity", "-Infinity"]) {
    const payload = JSON.parse(JSON.stringify({ ...base, port: Number(text) }));
    assert.equal(payload.port, null);
    await assert.rejects(
      queryRemoteDatabase(payload),
      (e) => e.message === "MySQL端口无效",
    );
  }
  assert.equal(
    remoteConnectionConfig(
      JSON.parse(JSON.stringify({ ...base, port: Number("") })),
    ).port,
    3306,
  );
  for (const text of ["3.306e3", "0xcea"]) {
    const payload = JSON.parse(JSON.stringify({ ...base, port: Number(text) }));
    assert.equal(payload.port, 3306);
    assert.equal(remoteConnectionConfig(payload).port, 3306);
  }
});

test("accepted decimal ports retain exact SSH target while old zero defaults remain rejected there", async (t) => {
  const { startSSHFixture } = await import("./fixtures/ssh-server.mjs");
  const { openDatabaseSSH } = await import("../src/database-ssh.mjs");
  const server = net.createServer((socket) => socket.pipe(socket));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const fixture = await startSSHFixture({
    targets: [{ host: "db.fixture", port }],
  });
  t.after(async () => {
    await fixture.close();
    await new Promise((r) => server.close(r));
  });
  for (const value of [port, "00" + port]) {
    const input = {
      ...base,
      host: "db.fixture",
      port: value,
      ssh: fixture.ssh,
    };
    assert.equal(remoteConnectionConfig(input).port, port);
    const tunnel = await openDatabaseSSH(input);
    tunnel.close();
    await tunnel.closed;
  }
  assert.deepEqual(fixture.stats.forwarded, [
    { host: "db.fixture", port },
    { host: "db.fixture", port },
  ]);
  for (const value of [0, "", "0"])
    await assert.rejects(
      queryRemoteDatabase({ ...base, port: value, ssh: fixture.ssh }),
      /SSH 数据库目标无效/,
    );
  assert.equal(fixture.stats.forwarded.length, 2);
});
