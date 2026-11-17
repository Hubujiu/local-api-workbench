import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  mutateRedis,
  redisWriteCommand,
  queryRedis,
  parseRESP,
} from "../src/redis.mjs";
const base = {
  type: "redis",
  allowWrite: true,
  host: "127.0.0.1",
  port: 6379,
  database: "0",
  command: ["SET", "fixture", "value"],
};
async function wire(t, reply) {
  const seen = [],
    sockets = new Set();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const frame = parseRESP(pending);
      if (!frame) return;
      assert.equal(frame.bytes, pending.length);
      pending = Buffer.alloc(0);
      const command = frame.value.map((value) => value.toString());
      seen.push(command);
      reply(command, socket);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    config: { ...base, port: server.address().port },
    seen,
    connections: () => connections,
  };
}
test("Redis SET requires a one-shot grant, explicit target, dense string arguments and bounded options", async (t) => {
  const f = await wire(t, (_command, socket) => socket.end("+OK\r\n"));
  for (const patch of [
    { allowWrite: false },
    { allowWrite: "true" },
    { allowWrite: undefined },
    { type: "mysql" },
    { host: "" },
    { port: 0 },
    { port: true },
    { database: "" },
    { database: undefined },
    { database: true },
  ]) {
    await assert.rejects(mutateRedis({ ...f.config, ...patch }));
  }
  assert.equal(f.connections(), 0);
  assert.deepEqual(
    redisWriteCommand({
      ...base,
      command: ["set", "key\r\n中", "", "px", "10", "nx"],
    }),
    ["SET", "key\r\n中", "", "PX", "10", "NX"],
  );
  assert.deepEqual(
    redisWriteCommand({
      ...base,
      command: undefined,
      sql: '["SET","k","v","XX","KEEPTTL"]',
    }),
    ["SET", "k", "v", "XX", "KEEPTTL"],
  );
  const sparse = ["SET", , "value"];
  for (const command of [
    ["DEL", "k"],
    ["EVAL", "x", "0"],
    ["SET", "k", "v", "GET"],
    ["MSET", "a", "b"],
    ["SET", "", "v"],
    ["SET", 1, "v"],
    sparse,
    ["SET", "k", "v", "NX", "XX"],
    ["SET", "k", "v", "NX", "NX"],
    ["SET", "k", "v", "EX", "1", "KEEPTTL"],
    ["SET", "k", "v", "PX", "0"],
    ["SET", "k", "v", "PX", "2147483648"],
    ["SET", "k", "v", "EX"],
    ["SET", "k", "v", "EX", "1.5"],
    ["SET", "k", "v", "EXAT", "1"],
    ["SET", "k", "x".repeat(4097)],
    ["SET", "\ud800", "v"],
    ["SET", "k", "\udfff"],
  ]) {
    assert.throws(() => redisWriteCommand({ ...base, command }));
  }
  await assert.rejects(queryRedis(f.config), /只读/);
  assert.equal(f.connections(), 0);
});
test("Redis writes wait for AUTH and SELECT and distinguish acknowledgement from conditional no-op", async (t) => {
  const f = await wire(t, (command, socket) => {
    if (["AUTH", "SELECT"].includes(command[0])) socket.write("+OK\r\n");
    else socket.end(command.includes("NX") ? "$-1\r\n" : "+OK\r\n");
  });
  const result = await mutateRedis({
    ...f.config,
    user: "fixture",
    password: "fixture-only",
    database: "2",
  });
  assert.equal(result.acknowledged, true);
  assert.equal(result.applied, true);
  assert.equal(result.affectedKeys, 1);
  assert.equal(result.limit, 1);
  assert.deepEqual(f.seen, [
    ["AUTH", "fixture", "fixture-only"],
    ["SELECT", "2"],
    ["SET", "fixture", "value"],
  ]);
  assert(!JSON.stringify(result).includes("fixture-only"));
  const unchanged = await mutateRedis({
    ...f.config,
    command: ["SET", "fixture", "different", "NX"],
  });
  assert.equal(unchanged.applied, false);
  assert.equal(unchanged.affectedKeys, 0);
  assert.equal(unchanged.acknowledged, true);
});
test("Redis never sends SET after failed authentication or selection", async (t) => {
  const f = await wire(t, (_command, socket) =>
    socket.end("-ERR fixture rejection\r\n"),
  );
  await assert.rejects(
    mutateRedis({ ...f.config, password: "fixture-only" }),
    /Redis/,
  );
  await assert.rejects(mutateRedis({ ...f.config, database: "2" }), /Redis/);
  assert.deepEqual(f.seen, [
    ["AUTH", "fixture-only"],
    ["SELECT", "2"],
  ]);
});
test("Redis lost or malformed SET acknowledgements are uncertain and never replayed", async (t) => {
  for (const response of [null, ":1\r\n", "$-1\r\n", "+OK\r\n+OK\r\n"]) {
    const f = await wire(t, (_command, socket) =>
      response === null ? socket.end() : socket.end(response),
    );
    await assert.rejects(mutateRedis(f.config), /结果可能不确定.*不能.*重试/);
    assert.equal(f.connections(), 1);
    assert.deepEqual(f.seen, [["SET", "fixture", "value"]]);
  }
  const malformedNull = await wire(t, (_command, socket) =>
    socket.end("*-1\r\n"),
  );
  await assert.rejects(
    mutateRedis({
      ...malformedNull.config,
      command: ["SET", "fixture", "value", "NX"],
    }),
    /结果可能不确定/,
  );
  const hung = await wire(t, () => {});
  await assert.rejects(
    mutateRedis({ ...hung.config, timeoutMs: 100 }),
    /超时.*结果可能不确定/,
  );
  assert.equal(hung.connections(), 1);
});

test("manual database HTTP writes require the grant on each request and leave read-only dispatch unchanged", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "redis-write-api-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const project = await app.store.create("Redis write fixture");
  const f = await wire(t, (_command, socket) => socket.end("+OK\r\n"));
  const call = (body) =>
    fetch(app.url + "/api/projects/" + project.id + "/database", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      body: JSON.stringify(body),
    });
  for (const allowWrite of [false, "true", undefined])
    assert.equal((await call({ ...f.config, allowWrite })).status, 400);
  assert.equal(f.connections(), 0);
  const result = await call(f.config);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).applied, true);
  assert.equal(
    (await call({ ...f.config, allowWrite: undefined })).status,
    400,
  );
  assert.deepEqual(f.seen, [["SET", "fixture", "value"]]);
});
