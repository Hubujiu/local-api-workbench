import assert from "node:assert/strict";
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
