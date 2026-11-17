import test from "node:test";
import assert from "node:assert/strict";
import tls from "node:tls";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { channel } from "node:diagnostics_channel";
import { mutateMySQL, mysqlWriteUsage } from "../src/mysql-write.mjs";
import { openDatabaseSSH } from "../src/database-ssh.mjs";
import { startSSHFixture } from "./fixtures/ssh-server.mjs";
import { startMySQLWritePeer } from "./fixtures/mysql-write-peer.mjs";

const cert = await readFile(
    new URL("./fixtures/localhost.crt", import.meta.url),
  ),
  key = await readFile(new URL("./fixtures/localhost.key", import.meta.url)),
  secureContext = tls.createSecureContext({ cert, key });
function observePort(port) {
  const clients = [];
  const observe = ({ socket }) => {
    socket.once("connect", () => {
      if (socket.remotePort !== port) return;
      const client = { socket, closed: false };
      socket.once("close", () => {
        client.closed = true;
      });
      clients.push(client);
    });
  };
  channel("net.client.socket").subscribe(observe);
  return {
    clients,
    close: () => channel("net.client.socket").unsubscribe(observe),
  };
}
function allClosed(clients, count) {
  assert.equal(clients.length, count);
  assert(
    clients.every((client) => client.closed),
    "actual owned local transport close precedes write lease release",
  );
  assert.equal(mysqlWriteUsage().active, 0);
}

test(
  "MySQL writes own both verified TLS streams and close held auth/metadata without unhandled driver errors",
  { timeout: 15000 },
  async () => {
    for (const hold of [undefined, "control-handshake", "metadata-prepare"]) {
      const f = await startMySQLWritePeer({ secureContext, hold });
      try {
        const write = mutateMySQL(
          { ...f.input, host: "localhost", ssl: true, ca: cert },
          { queryTimeoutMs: 150 },
        );
        if (hold) {
          await assert.rejects(write, /超时/);
          assert(!f.records.some((record) => record.stage === "dml-execute"));
          assert(!f.records.some((record) => record.stage === "commit"));
        } else assert.equal((await write).committed, true);
        allClosed(f.clients, 2);
        assert(
          f.peers.every((peer) => peer.secure),
          "both connections negotiated TLS",
        );
      } finally {
        await f.close();
      }
    }
  },
);

test(
  "held TLS ClientHello closes cleanly and the write process exits without hidden driver timers or uncaught errors",
  { timeout: 7000 },
  async () => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import assert from "node:assert/strict";
    import tls from "node:tls";
    import { readFile } from "node:fs/promises";
    import { startMySQLWritePeer } from "./tests/fixtures/mysql-write-peer.mjs";
    import { mutateMySQL, mysqlWriteUsage } from "./src/mysql-write.mjs";
    const cert = await readFile("tests/fixtures/localhost.crt"), key = await readFile("tests/fixtures/localhost.key");
    const f = await startMySQLWritePeer({secureContext: tls.createSecureContext({cert,key}), hold: "tls-handshake"});
    try {
      await assert.rejects(mutateMySQL({...f.input,host:"localhost",ssl:true,ca:cert}), /超时/);
      assert.equal(f.clients.length, 1);
      assert(f.clients.every(client => client.closed));
      assert.equal(mysqlWriteUsage().active, 0);
      assert.deepEqual(f.records, []);
      process.stdout.write("closed-without-SQL");
    } finally { await f.close(); }
  `,
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        timeout: 5000,
        maxBuffer: 65536,
      },
    );
    assert.equal(stdout, "closed-without-SQL");
    assert.equal(stderr, "");
  },
);

test(
  "MySQL write TLS verification rejects an untrusted certificate before SQL and has no plaintext fallback",
  { timeout: 5000 },
  async () => {
    const f = await startMySQLWritePeer({ secureContext });
    try {
      await assert.rejects(
        mutateMySQL({ ...f.input, host: "localhost", ssl: true }),
        /TLS|连接/,
      );
      allClosed(f.clients, 1);
      assert.equal(f.peers.length, 1);
      assert.deepEqual(f.records, []);
    } finally {
      await f.close();
    }
  },
);

test(
  "pinned SSH write owns data and control transports, preserves TLS identity checks and reuses all five tunnel leases after faults",
  { timeout: 15000 },
  async () => {
    const f = await startMySQLWritePeer({
        secureContext,
        hold: "metadata-prepare",
      }),
      ssh = await startSSHFixture({
        targets: [
          { host: "localhost", port: f.input.port },
          { host: "wrong.fixture", port: f.input.port },
        ],
      }),
      observed = observePort(ssh.ssh.port),
      input = {
        ...f.input,
        host: "localhost",
        ssh: ssh.ssh,
        ssl: true,
        ca: cert,
      };
    const retained = [];
    try {
      await assert.rejects(mutateMySQL(input, { queryTimeoutMs: 150 }), /超时/);
      allClosed(observed.clients, 2);
      assert.deepEqual(ssh.stats.forwarded, [
        { host: "localhost", port: f.input.port },
        { host: "localhost", port: f.input.port },
      ]);
      assert(!f.records.some((record) => record.stage === "dml-execute"));
      assert(f.peers.every((peer) => peer.secure));
      const attempts = f.peers.length;
      await assert.rejects(
        mutateMySQL({ ...input, host: "wrong.fixture" }),
        /TLS|连接/,
      );
      allClosed(observed.clients, 3);
      assert.equal(
        f.peers.length,
        attempts + 1,
        "wrong TLS hostname never retries or falls back to a direct connection",
      );
      await assert.rejects(
        mutateMySQL({
          ...input,
          ssh: {
            ...ssh.ssh,
            hostKeySHA256:
              "SHA256:" + Buffer.alloc(32).toString("base64").replace(/=$/, ""),
          },
        }),
        /SSH|校验/,
      );
      allClosed(observed.clients, 4);
      assert.equal(
        f.peers.length,
        attempts + 1,
        "wrong SSH pin reaches no database peer",
      );
      // All slots must be reusable, not merely a single operation after a leak.
      for (let i = 0; i < 5; i++) retained.push(await openDatabaseSSH(input));
      await assert.rejects(openDatabaseSSH(input), /并发最多5/);
      for (const tunnel of retained) tunnel.close();
      await Promise.all(retained.map((tunnel) => tunnel.closed));
      retained.length = 0;
      allClosed(observed.clients, 9);
      // Four retained channels make a write's data channel the fifth. Its control
      // acquisition must fail and release the acquired data channel, not the four
      // unrelated channels, so a fifth channel can immediately be reacquired.
      for (let i = 0; i < 4; i++) retained.push(await openDatabaseSSH(input));
      const before = observed.clients.length;
      await assert.rejects(mutateMySQL(input), /取消连接.*失败/);
      assert.equal(mysqlWriteUsage().active, 0);
      assert.equal(observed.clients.length, before + 1);
      assert(observed.clients.at(-1).closed);
      assert(
        observed.clients
          .slice(before - 4, before)
          .every((client) => !client.closed),
      );
      retained.push(await openDatabaseSSH(input));
      await assert.rejects(openDatabaseSSH(input), /并发最多5/);
    } finally {
      for (const tunnel of retained) tunnel.close();
      await Promise.all(retained.map((tunnel) => tunnel.closed));
      observed.close();
      await ssh.close();
      await f.close();
    }
  },
);
