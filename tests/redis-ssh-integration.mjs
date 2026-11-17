// Ordinary CI only: forwards to the actual Redis 7.2 service seeded by ci.yml.
// The SSH fixture is a real pinned ssh2 endpoint, not a substitute Redis driver.
import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mutateRedis, parseRESP } from "../src/redis.mjs";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import { startSSHFixture } from "./fixtures/ssh-server.mjs";
import { verifyNativeRedisFlow } from "./native-redis-integration.mjs";
import { verifyNativeRedisCLIFlow } from "./native-redis-cli-integration.mjs";
import { verifyMCPDatabaseFlow } from "./mcp-database-integration.mjs";
import { verifyMCPStdioNativeDatabaseFlow } from "./mcp-stdio-native-database-integration.mjs";

const prefix = "localapi:ssh:" + randomUUID();
const sockets = new Set();
let forwarded = 0,
  acknowledged = false;
// Deliberately lose the real service's SET acknowledgement, not its mutation.
const proxy = net.createServer({ allowHalfOpen: true }, (downstream) => {
  const upstream = net.connect({ host: "127.0.0.1", port: 6379 });
  for (const socket of [downstream, upstream]) {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  }
  let pending = Buffer.alloc(0),
    response = Buffer.alloc(0);
  downstream.on("data", (bytes) => {
    pending = Buffer.concat([pending, bytes]);
    let frame;
    while ((frame = parseRESP(pending))) {
      forwarded++;
      assert.equal(frame.value[0].toString(), "SET");
      upstream.write(pending.subarray(0, frame.bytes));
      pending = pending.subarray(frame.bytes);
    }
  });
  upstream.on("data", (bytes) => {
    response = Buffer.concat([response, bytes]);
    acknowledged = response.equals(Buffer.from("+OK\r\n"));
  });
  downstream.once("end", () => {
    downstream.destroy();
    upstream.destroy();
  });
  downstream.once("close", () => upstream.destroy());
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
let fixture;
try {
  fixture = await startSSHFixture({
    targets: [
      { host: "redis.fixture", port: 6379 },
      { host: "redis-ack-loss.fixture", port: proxy.address().port },
    ],
  });
  const config = {
    type: "redis",
    host: "redis.fixture", // Intentionally not resolvable by the client.
    port: 6379,
    database: "0",
    ssh: fixture.ssh,
  };
  // Observe only the client's SSH transport, excluding fixture upstream sockets.
  async function owned(operation) {
    const connections = [];
    const observe = ({ socket }) => {
      socket.once("connect", () => {
        if (socket.remotePort !== fixture.ssh.port) return;
        const connection = { closed: false };
        connections.push(connection);
        socket.once("close", () => (connection.closed = true));
      });
    };
    channel("net.client.socket").subscribe(observe);
    try {
      return await operation();
    } finally {
      channel("net.client.socket").unsubscribe(observe);
      assert.equal(connections.length, 1, "one pinned SSH client, no replay");
      assert(connections[0].closed, "settlement owns actual SSH socket close");
    }
  }
  const read = (command, extra = {}) =>
    owned(() => queryRemoteDatabase({ ...config, ...extra, command }));
  const write = (command, extra = {}) =>
    owned(() =>
      mutateRedis({ ...config, ...extra, allowWrite: true, command }),
    );

  assert.equal(
    (await read(["GET", "localapi:fixture"])).rows[0].value,
    "hello",
  );
  assert.equal(
    (await read(["GET", "localapi:fixture"], { port: undefined })).rows[0]
      .value,
    "hello",
  );
  assert.deepEqual(fixture.stats.forwarded.at(-1), {
    host: "redis.fixture",
    port: 6379,
  });
  const beforeReadDenial = fixture.stats.authenticated;
  await assert.rejects(
    queryRemoteDatabase({ ...config, command: ["SET", prefix, "forbidden"] }),
    /只读/,
  );
  assert.equal(fixture.stats.authenticated, beforeReadDenial);
  const privateSSH = { ...fixture.ssh, privateKey: fixture.privateKey };
  delete privateSSH.password;
  for (const [authentication, ssh] of [
    ["password", fixture.ssh],
    ["key", privateSSH],
  ]) {
    const key = prefix + ":" + authentication;
    assert.equal(
      (await write(["SET", key, "中\r\nvalue", "NX", "EX", "60"], { ssh }))
        .applied,
      true,
    );
    assert.equal(
      (await read(["GET", key], { ssh })).rows[0].value,
      "中\r\nvalue",
    );
    assert.equal(
      (await write(["SET", key, "not-applied", "NX"], { ssh })).applied,
      false,
    );
    assert.equal(
      (await read(["GET", key], { ssh })).rows[0].value,
      "中\r\nvalue",
    );
    assert.equal(
      (await write(["SET", key, "", "XX", "KEEPTTL"], { ssh })).applied,
      true,
    );
    assert.equal((await read(["GET", key], { ssh })).rows[0].value, "");
    const ttl = (await read(["PTTL", key], { ssh })).rows[0].value;
    assert(ttl > 0 && ttl <= 60000);
    assert.equal(
      (await write(["SET", key + ":missing", "v", "XX", "PX", "100"], { ssh }))
        .applied,
      false,
    );
    assert.equal(
      (await write(["SET", key, "persistent"], { ssh })).applied,
      true,
    );
    assert.equal((await read(["PTTL", key], { ssh })).rows[0].value, -1);
    assert.equal(
      (await write(["SET", key, "expiring", "XX", "PX", "30000"], { ssh }))
        .applied,
      true,
    );
    const resetTTL = (await read(["PTTL", key], { ssh })).rows[0].value;
    assert(resetTTL > 0 && resetTTL <= 30000);
  }
  console.log("REAL_REDIS_SSH_PASSWORD_KEY_GET_SET_NX_XX_TTL_LOCAL_CLOSE_PASS");

  await assert.rejects(
    write(["SET", prefix + ":lost-ack", "applied-once", "EX", "60"], {
      host: "redis-ack-loss.fixture",
      port: proxy.address().port,
    }),
    { code: "REDIS_WRITE_UNCERTAIN" },
  );
  assert.equal(acknowledged, true, "actual Redis ACK was lost in transit");
  assert.equal(forwarded, 1, "exactly one complete SET, no replay");
  assert.equal(
    (await read(["GET", prefix + ":lost-ack"])).rows[0].value,
    "applied-once",
  );
  console.log("REAL_REDIS_SSH_LOST_ACK_ONE_SET_UNCERTAIN_READBACK_PASS");

  // Plain imported Redis sources are explicitly rebound to canonical SSH grants.
  // This does not enable native imported active SSH or native SET over SSH.
  await verifyNativeRedisFlow(config);
  await verifyNativeRedisCLIFlow({ ...config, ssh: privateSSH });
  await verifyMCPDatabaseFlow(config, { nativeImport: true });
  await verifyMCPStdioNativeDatabaseFlow({ ...config, ssh: privateSSH });
  console.log("REAL_REDIS_SSH_MCP_STDIO_GRANTS_ISOLATION_RESTART_SECRETS_PASS");
  console.log(
    "REAL_REDIS_SSH_NATIVE_READ_REBIND_CLI_STDIN_HTTP_MCP_REVOKE_RESTART_PASS",
  );
} finally {
  await fixture?.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => proxy.close(resolve));
}
