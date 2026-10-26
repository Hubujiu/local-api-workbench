import assert from "node:assert/strict";
import { mutateRedis } from "../src/redis.mjs";
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
const write = (command) =>
  mutateRedis({
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

const { verifyNativeRedisFlow } = await import(
  "./native-redis-integration.mjs"
);
await verifyNativeRedisFlow({
  type: "redis",
  host: "127.0.0.1",
  port: 6379,
  database: "0",
});
