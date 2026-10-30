import assert from "node:assert/strict";
import net from "node:net";
import { channel } from "node:diagnostics_channel";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { mutateRedis, parseRESP } from "../src/redis.mjs";
import { randomUUID } from "node:crypto";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
const run = (command) =>
  queryRemoteDatabase({
    type: "redis",
    host: "127.0.0.1",
    port: 6379,
    command,
  });
assert.equal((await run(["PING"])).rows[0].value, "PONG");
assert.equal((await run(["GET", "localapi:fixture"])).rows[0].value, "hello");
assert.deepEqual(
  (await run(["MGET", "localapi:fixture", "localapi:missing"])).rows.map(
    (r) => r.value,
  ),
  ["hello", null],
);
assert.deepEqual(
  (await run(["LRANGE", "localapi:list", "0", "2"])).rows.map((r) => r.value),
  ["x", "y", "z"],
);
const scan = await run(["HSCAN", "localapi:hash", "0", "COUNT", "10"]);
assert.equal(scan.cursor, "0");
assert.deepEqual(Object.fromEntries(scan.rows.map((r) => [r.key, r.value])), {
  a: "1",
  b: "2",
});
await assert.rejects(run(["SET", "localapi:fixture", "changed"]), /只读/);
assert.equal((await run(["GET", "localapi:fixture"])).rows[0].value, "hello");
console.log("REAL_REDIS_FIXTURES_PASS");

const writeKey = "localapi:write:" + randomUUID();
async function ownedWrite(input) {
  const clients = [];
  const observe = ({ socket }) =>
    socket.once("connect", () => {
      if (socket.remotePort !== input.port) return;
      const client = { closed: false };
      socket.once("close", () => {
        client.closed = true;
      });
      clients.push(client);
    });
  channel("net.client.socket").subscribe(observe);
  try {
    return await mutateRedis(input);
  } finally {
    channel("net.client.socket").unsubscribe(observe);
    assert.equal(clients.length, 1, "one connection, no automatic reconnect");
    assert(
      clients.every((client) => client.closed),
      "real Redis write settles after local close",
    );
  }
}
const write = (command) =>
  ownedWrite({
    type: "redis",
    allowWrite: true,
    host: "127.0.0.1",
    port: 6379,
    database: "0",
    command,
  });

assert.equal(
  (await write(["SET", writeKey, "中\r\nvalue", "NX", "EX", "60"])).applied,
  true,
);
assert.equal((await run(["GET", writeKey])).rows[0].value, "中\r\nvalue");
assert.equal(
  (await write(["SET", writeKey, "not-applied", "NX", "EX", "60"])).applied,
  false,
);
assert.equal((await run(["GET", writeKey])).rows[0].value, "中\r\nvalue");
assert.equal(
  (await write(["SET", writeKey, "", "XX", "KEEPTTL"])).applied,
  true,
);
assert.equal((await run(["GET", writeKey])).rows[0].value, "");
const ttl = (await run(["PTTL", writeKey])).rows[0].value;
assert(ttl > 0 && ttl <= 60000, "KEEPTTL preserves the original expiry");
assert.equal(
  (await write(["SET", writeKey + ":missing", "v", "XX", "PX", "100"])).applied,
  false,
);
assert.equal(
  (await write(["SET", writeKey, "persistent-value"])).applied,
  true,
);
assert.equal(
  (await run(["PTTL", writeKey])).rows[0].value,
  -1,
  "plain SET clears previous TTL",
);
assert.equal(
  (await write(["SET", writeKey, "expiring-value", "XX", "PX", "30000"]))
    .applied,
  true,
);
const resetTTL = (await run(["PTTL", writeKey])).rows[0].value;
assert(
  resetTTL > 0 && resetTTL <= 30000,
  "PX applies the requested millisecond expiry",
);
console.log("REAL_REDIS_SET_ACK_CONDITION_EXPIRY_PASS");

// Forward a SET to the real service but deliberately drop its ACK. This is a
// transport fault around a real mutation, not a simulated Redis success.
const proxySockets = new Set();
let upstreamAcknowledged = false,
  forwarded = 0;
const proxy = net.createServer({ allowHalfOpen: true }, (downstream) => {
  const upstream = net.connect({ host: "127.0.0.1", port: 6379 });
  for (const socket of [downstream, upstream]) {
    proxySockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => proxySockets.delete(socket));
  }
  let commands = Buffer.alloc(0);
  downstream.on("data", (bytes) => {
    commands = Buffer.concat([commands, bytes]);
    let frame;
    while ((frame = parseRESP(commands))) {
      forwarded++;
      assert.equal(frame.value[0].toString(), "SET");
      commands = commands.subarray(frame.bytes);
    }
    upstream.write(bytes);
  });
  let reply = "";
  upstream.on("data", (bytes) => {
    reply += bytes.toString();
    upstreamAcknowledged = reply === "+OK\r\n";
  });
  downstream.once("end", () => {
    downstream.destroy();
    upstream.destroy();
  });
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const uncertainKey = writeKey + ":lost-ack";
try {
  await assert.rejects(
    ownedWrite({
      type: "redis",
      allowWrite: true,
      host: "127.0.0.1",
      port: proxy.address().port,
      database: "0",
      command: ["SET", uncertainKey, "applied-before-ack-loss", "EX", "60"],
    }),
    { code: "REDIS_WRITE_UNCERTAIN" },
  );
  assert.equal(
    upstreamAcknowledged,
    true,
    "real Redis ACK reached proxy but not client",
  );
  assert.equal(forwarded, 1, "one complete SET command, no replay");
  assert.equal(
    (await run(["GET", uncertainKey])).rows[0].value,
    "applied-before-ack-loss",
  );
} finally {
  for (const socket of proxySockets) socket.destroy();
  await new Promise((resolve) => proxy.close(resolve));
}
console.log("REAL_REDIS_ACK_LOSS_UNKNOWN_READBACK_LOCAL_CLOSE_PASS");

const root = await mkdtemp(join(tmpdir(), "redis-real-http-"));
const app = await createApp({ root, port: 0 });
try {
  const project = await app.store.create("Real Redis ephemeral fixture");
  const before = await app.store.get(project.id);
  const call = (allowWrite, value) =>
    fetch(app.url + "/api/projects/" + project.id + "/database", {
      method: "POST",
      headers: {
        "x-local-token": app.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "redis",
        host: "127.0.0.1",
        port: 6379,
        database: "0",
        allowWrite,
        command: ["SET", writeKey + ":http", value, "EX", "60"],
      }),
    });
  assert.equal((await call(false, "denied")).status, 400);
  assert.equal((await run(["GET", writeKey + ":http"])).rows[0].value, null);
  const response = await call(true, "authorized");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).acknowledged, true);
  assert.equal(
    (await run(["GET", writeKey + ":http"])).rows[0].value,
    "authorized",
  );
  assert.equal((await call(false, "still-denied")).status, 400);
  assert.equal(
    (await run(["GET", writeKey + ":http"])).rows[0].value,
    "authorized",
  );
  assert.deepEqual(await app.store.get(project.id), before);
} finally {
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
console.log("REAL_REDIS_HTTP_EXPLICIT_GRANT_READBACK_NO_PERSISTENCE_PASS");

const { verifyNativeRedisFlow } = await import(
  "./native-redis-integration.mjs"
);
await verifyNativeRedisFlow({
  type: "redis",
  host: "127.0.0.1",
  port: 6379,
  database: "0",
});

const { verifyMCPDatabaseFlow } = await import(
  "./mcp-database-integration.mjs"
);
await verifyMCPDatabaseFlow(
  { type: "redis", host: "127.0.0.1", port: 6379, database: "0" },
  { nativeImport: true },
);
console.log("REAL_NATIVE_REDIS_MCP_SDK_GRANTS_REVOKE_RESTART_PASS");

const { verifyNativeRedisCLIFlow } = await import(
  "./native-redis-cli-integration.mjs"
);
await verifyNativeRedisCLIFlow({
  type: "redis",
  host: "127.0.0.1",
  port: 6379,
  database: "0",
});

const { verifyNativeRedisOwnerFlow } = await import(
  "./native-redis-owner-integration.mjs"
);
await verifyNativeRedisOwnerFlow({
  type: "redis",
  host: "127.0.0.1",
  port: 6379,
  database: "0",
});
