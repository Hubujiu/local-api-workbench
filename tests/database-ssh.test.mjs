import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { startSSHFixture } from "./fixtures/ssh-server.mjs";
import { openDatabaseSSH, databaseSSHConfig } from "../src/database-ssh.mjs";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";

async function echo(t) {
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.pipe(s);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  return server.address().port;
}
test("SSH uses pinned host identity, password/key authentication and one explicit forward without a local listener", async (t) => {
  const port = await echo(t),
    fixture = await startSSHFixture({
      targets: [{ host: "db.fixture", port }],
    });
  t.after(() => fixture.close());
  for (const ssh of [
    fixture.ssh,
    { ...fixture.ssh, password: undefined, privateKey: fixture.privateKey },
    {
      ...fixture.ssh,
      password: undefined,
      privateKey: fixture.encryptedPrivateKey,
      passphrase: "fixture-key-passphrase",
    },
  ]) {
    if (ssh.privateKey) delete ssh.password;
    const tunnel = await openDatabaseSSH({
      type: "postgres",
      host: "db.fixture",
      port,
      ssh,
    });
    try {
      const received = once(tunnel.stream, "data");
      tunnel.stream.write("fixture message");
      assert.equal((await received)[0].toString(), "fixture message");
    } finally {
      tunnel.close();
    }
  }
  assert.equal(fixture.stats.authenticated, 3);
  assert.deepEqual(fixture.stats.forwarded, [
    { host: "db.fixture", port },
    { host: "db.fixture", port },
    { host: "db.fixture", port },
  ]);
});
test("SSH rejects wrong host key before credentials, rejects bad auth/forward and never falls back direct", async (t) => {
  const port = await echo(t),
    fixture = await startSSHFixture({
      targets: [{ host: "db.fixture", port }],
    });
  t.after(() => fixture.close());
  const input = { type: "mysql", host: "db.fixture", port, ssh: fixture.ssh };
  await assert.rejects(
    openDatabaseSSH({
      ...input,
      ssh: {
        ...fixture.ssh,
        hostKeySHA256:
          "SHA256:" + Buffer.alloc(32).toString("base64").replace(/=$/, ""),
      },
    }),
    /校验/,
  );
  assert.equal(fixture.stats.authenticated, 0);
  assert.equal(fixture.stats.forwarded.length, 0);
  await assert.rejects(
    openDatabaseSSH({ ...input, ssh: { ...fixture.ssh, password: "wrong" } }),
    /SSH/,
  );
  assert.equal(fixture.stats.forwarded.length, 0);
  await assert.rejects(
    openDatabaseSSH({ ...input, host: "not-allowed.fixture" }),
    /转发/,
  );
  await assert.rejects(
    queryRemoteDatabase({ ...input, type: "redis", sql: "PING" }),
    /不会退回直连/,
  );
  for (const patch of [
    { hostKeySHA256: "" },
    { password: undefined },
    { agent: "ambient-agent" },
    { privateKey: "extra" },
    { port: 0 },
  ])
    assert.throws(() => databaseSSHConfig({ ...fixture.ssh, ...patch }));
});
test("SSH session credentials remain project-scoped, redacted and nonpersistent", async () => {
  const sessions = new DatabaseSessions();
  const ssh = {
    host: "localhost",
    username: "fixture",
    password: "secret-fixture",
    hostKeySHA256:
      "SHA256:" + Buffer.alloc(32).toString("base64").replace(/=$/, ""),
  };
  const grant = sessions.register("a", {
    name: "private",
    type: "postgres",
    host: "localhost",
    ssh,
  });
  assert.deepEqual(sessions.list("b"), []);
  assert.equal(
    JSON.stringify(sessions.list("a")).includes("secret-fixture"),
    false,
  );
  await assert.rejects(
    sessions.query("b", { connectionId: grant.id, sql: "SELECT 1" }),
    /未授权/,
  );
  assert.throws(
    () =>
      sessions.register("a", {
        name: "unsupported",
        type: "sqlite",
        filename: "test",
        ssh,
      }),
    /仅支持/,
  );
  sessions.revoke("a", grant.id);
  await assert.rejects(
    sessions.query("a", { connectionId: grant.id, sql: "SELECT 1" }),
    /失效/,
  );
});
test("SSH forwarding does not weaken database TLS hostname and CA checks", async (t) => {
  const key = await readFile(
      new URL("./fixtures/localhost.key", import.meta.url),
    ),
    cert = await readFile(new URL("./fixtures/localhost.crt", import.meta.url));
  const sockets = new Set(),
    server = tls.createServer({ key, cert }, (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.pipe(s);
    });
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  const fixture = await startSSHFixture({
    targets: [
      { host: "localhost", port },
      { host: "wrong.fixture", port },
    ],
  });
  t.after(() => fixture.close());
  for (const [host, ca, success] of [
    ["localhost", cert, true],
    ["wrong.fixture", cert, false],
    ["localhost", undefined, false],
  ]) {
    const tunnel = await openDatabaseSSH({
      type: "postgres",
      host,
      port,
      ssh: fixture.ssh,
      ssl: true,
    });
    const socket = tls.connect({
      socket: tunnel.stream,
      servername: host,
      ca,
      rejectUnauthorized: true,
    });
    try {
      if (success) {
        await once(socket, "secureConnect");
        const data = once(socket, "data");
        socket.write("tls fixture");
        assert.equal((await data)[0].toString(), "tls fixture");
      } else {
        await assert.rejects(once(socket, "secureConnect"));
      }
    } finally {
      socket.destroy();
      tunnel.close();
    }
  }
});

test("SSH five-channel limit is released after close and forwarding failure", async (t) => {
  const port = await echo(t),
    fixture = await startSSHFixture({
      targets: [{ host: "db.fixture", port }],
    });
  t.after(() => fixture.close());
  const input = {
      type: "postgres",
      host: "db.fixture",
      port,
      ssh: fixture.ssh,
    },
    tunnels = [];
  try {
    for (let i = 0; i < 5; i++) tunnels.push(await openDatabaseSSH(input));
    await assert.rejects(openDatabaseSSH(input), /并发最多5/);
  } finally {
    for (const tunnel of tunnels) tunnel.close();
  }
  await assert.rejects(
    openDatabaseSSH({ ...input, host: "denied.fixture" }),
    /转发/,
  );
  const next = await openDatabaseSSH(input);
  next.close();
});
test(
  "SSH handshake stalls time out and do not establish a database connection",
  { timeout: 7000 },
  async (t) => {
    const sockets = new Set(),
      server = net.createServer((s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
      });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    });
    const ssh = {
      host: "127.0.0.1",
      port: server.address().port,
      username: "fixture",
      password: "fixture",
      hostKeySHA256:
        "SHA256:" + Buffer.alloc(32).toString("base64").replace(/=$/, ""),
    };
    await assert.rejects(
      openDatabaseSSH({ type: "postgres", host: "db.fixture", ssh }),
      /SSH/,
    );
  },
);
