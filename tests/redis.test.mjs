import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  encodeRESP,
  parseRESP,
  redisCommand,
  queryRedis,
} from "../src/redis.mjs";

test("RESP2 encoding and bounded parsing preserve UTF-8 null binary and large integers", () => {
  assert.equal(
    encodeRESP(["GET", "中"]).toString(),
    "*2\r\n$3\r\nGET\r\n$3\r\n中\r\n",
  );
  assert.equal(parseRESP(Buffer.from("$-1\r\n")).value, null);
  assert.equal(
    parseRESP(Buffer.from(":9007199254740993\r\n")).value,
    "9007199254740993",
  );
  const full = Buffer.from("*2\r\n$1\r\na\r\n$0\r\n\r\n");
  assert.equal(parseRESP(full.subarray(0, -1)), null);
  assert.deepEqual(
    parseRESP(full).value.map((b) => b.toString()),
    ["a", ""],
  );
  for (const text of [
    "$999999999\r\n",
    "*999999999\r\n",
    ":bad\r\n",
    "$1\r\naXX",
    "-ERR fixture\r\n",
  ])
    assert.throws(() => parseRESP(Buffer.from(text)), /Redis|RESP/);
});
test("only bounded read commands are accepted; no writes scripts scans without bounds or admin commands", () => {
  assert.deepEqual(redisCommand({ sql: '["get","fixture"]' }), [
    "GET",
    "fixture",
  ]);
  assert.deepEqual(redisCommand({ command: ["SCAN", "0", "COUNT", "100"] }), [
    "SCAN",
    "0",
    "COUNT",
    "100",
  ]);
  assert.deepEqual(redisCommand({ command: ["LRANGE", "list", "-10", "-1"] }), [
    "LRANGE",
    "list",
    "-10",
    "-1",
  ]);
  for (const command of [
    ["SET", "k", "v"],
    ["EVAL", "return 1", "0"],
    ["CONFIG", "GET", "*"],
    ["KEYS", "*"],
    ["LRANGE", "x", "0", "-1"],
    ["LRANGE", "x", "0", "1000"],
    ["SCAN", "0", "COUNT", "999999"],
    ["HGETALL", "x"],
    ["MGET"],
    ["AUTH", "secret"],
  ])
    assert.throws(() => redisCommand({ command }), /Redis/);
});
test("Redis query uses one authenticated connection and keeps binary response data intact", async (t) => {
  const seen = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const frame = parseRESP(buffer);
      if (!frame) return;
      buffer = buffer.subarray(frame.bytes);
      const command = frame.value.map((b) => b.toString());
      seen.push(command);
      if (command[0] === "AUTH" || command[0] === "SELECT")
        socket.write("+OK\r\n");
      else {
        socket.write("*2\r\n$3\r\n");
        socket.end(Buffer.from([0, 255, 1, 13, 10, 36, 45, 49, 13, 10]));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await queryRedis({
    host: "127.0.0.1",
    port: server.address().port,
    user: "fixture",
    password: "fixture-only",
    database: "2",
    command: ["MGET", "binary", "missing"],
  });
  assert.deepEqual(seen, [
    ["AUTH", "fixture", "fixture-only"],
    ["SELECT", "2"],
    ["MGET", "binary", "missing"],
  ]);
  assert.deepEqual(result.rows, [
    { index: 0, value: { encoding: "base64", data: "AP8B" } },
    { index: 1, value: null },
  ]);
  assert.equal(JSON.stringify(result).includes("fixture-only"), false);
});
test("Redis deadline and premature close fail without an unbounded reconnect", async (t) => {
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer((s) => {
    connections++;
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  await assert.rejects(
    queryRedis({
      port: server.address().port,
      command: ["PING"],
      timeoutMs: 100,
    }),
    /超时/,
  );
  assert.equal(connections, 1);
});

test("Redis TLS requires a trusted certificate and oversized replies fail before payload allocation", async (t) => {
  const tls = await import("node:tls"),
    { readFile } = await import("node:fs/promises");
  const key = await readFile(
      new URL("./fixtures/localhost.key", import.meta.url),
    ),
    cert = await readFile(new URL("./fixtures/localhost.crt", import.meta.url));
  const server = tls.createServer({ key, cert }, (socket) =>
    socket.once("data", () => socket.end("+PONG\r\n")),
  );
  server.on("tlsClientError", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = {
    host: "127.0.0.1",
    port: server.address().port,
    ssl: true,
    command: ["PING"],
  };
  await assert.rejects(queryRedis(config), /certificate|self.signed/i);
  assert.equal(
    (await queryRedis({ ...config, ca: cert.toString() })).rows[0].value,
    "PONG",
  );
  const large = net.createServer((socket) =>
    socket.once("data", () => socket.end("$999999999\r\n")),
  );
  await new Promise((resolve) => large.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => large.close(resolve)));
  await assert.rejects(
    queryRedis({ port: large.address().port, command: ["GET", "oversized"] }),
    /超过上限/,
  );
});
