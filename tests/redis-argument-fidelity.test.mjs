import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  redisCommand,
  redisWriteCommand,
  queryRedis,
  parseRESP,
} from "../src/redis.mjs";
import { normalizeDatabaseOperations } from "../src/script-database-tasks.mjs";

const invalid = [
  "\ud800",
  "\udfff",
  NaN,
  Infinity,
  -Infinity,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MIN_SAFE_INTEGER - 1,
];
const sqlInvalid = [
  '["GET","\\ud800"]',
  '["GET","\\udfff"]',
  '["GET",9007199254740993]',
  '["GET",-9007199254740993]',
  '["GET",1e400]',
];

test("Redis read policy rejects lossy Unicode and numeric arguments in both input routes", () => {
  for (const key of invalid)
    assert.throws(() => redisCommand({ command: ["GET", key] }), /Redis/);
  for (const sql of sqlInvalid)
    assert.throws(() => redisCommand({ sql }), /Redis/);
  for (const command of [
    ["MGET", "valid", "\ud800"],
    ["HMGET", "valid", "field", Infinity],
    ["HGET", "valid", Number.MAX_SAFE_INTEGER + 1],
  ])
    assert.throws(() => redisCommand({ command }), /Redis/);
});
test("Redis read normalization preserves valid finite floats, safe integers and exact string keys", () => {
  for (const key of [
    "中文🙂",
    "",
    "\u0000",
    "\ufffd",
    "9007199254740993",
    "1e400",
    1.5,
    1e-7,
    0,
    -0,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
  ]) {
    assert.deepEqual(redisCommand({ command: ["get", key] }), [
      "GET",
      String(key),
    ]);
  }
  assert.deepEqual(redisCommand({ sql: '["GET",1.5]' }), ["GET", "1.5"]);
});
test("Redis write policy remains string-only and exact", () => {
  assert.throws(
    () =>
      redisWriteCommand({
        command: ["SET", "valid", "\ud800"],
        allowWrite: true,
      }),
    /Redis/,
  );
  for (const key of [...invalid, 1.5, 123])
    assert.throws(
      () => redisWriteCommand({ command: ["SET", key, "v"], allowWrite: true }),
      /Redis/,
    );
  assert.deepEqual(
    redisWriteCommand({
      command: ["set", "9007199254740993", "中文🙂"],
      allowWrite: true,
    }),
    ["SET", "9007199254740993", "中文🙂"],
  );
});
test("native readonly Redis task normalization rejects lossy arguments before canonicalization", () => {
  const task = (query) => [
    {
      connectionId: "bound",
      query,
      resultShape: "redis-value",
      isConsoleOutput: 0,
      variables: [],
    },
  ];
  for (const sql of sqlInvalid)
    assert.throws(() => normalizeDatabaseOperations(task(sql)), /Redis/);
  assert.equal(
    normalizeDatabaseOperations(task('["GET","9007199254740993"]'))[0].query,
    '["GET","9007199254740993"]',
  );
});
test("invalid Redis reads open no connections; valid keys reach wire unchanged", async (t) => {
  let connections = 0;
  const seen = [];
  const server = net.createServer((socket) => {
    connections++;
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const frame = parseRESP(pending);
      if (!frame) return;
      seen.push(frame.value.map((b) => b.toString()));
      socket.end("$2\r\nok\r\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const config = { host: "127.0.0.1", port: server.address().port };
  for (const key of invalid)
    await assert.rejects(
      queryRedis({ ...config, command: ["GET", key] }),
      /Redis/,
    );
  for (const sql of sqlInvalid)
    await assert.rejects(queryRedis({ ...config, sql }), /Redis/);
  assert.equal(connections, 0);
  for (const key of [
    "中文🙂",
    "9007199254740993",
    1.5,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const result = await queryRedis({ ...config, command: ["GET", key] });
    assert.deepEqual(result.rows, [{ value: "ok" }]);
    assert.deepEqual(seen.at(-1), ["GET", String(key)]);
  }
  assert.equal(connections, 4);
});
