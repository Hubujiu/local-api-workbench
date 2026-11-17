import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import ssh2 from "ssh2";
import { syncBuiltinESMExports } from "node:module";
import {
  queryRedis,
  mutateRedis,
  observeNativeRedisSet,
  parseRESP,
} from "../src/redis.mjs";

const base = { type: "redis", host: "127.0.0.1", port: 6379, database: 0 };
const authError = (error) => {
  assert.equal(error.message, "Redis认证参数无效");
  return true;
};

test("Redis rejects malformed authentication before direct, TLS or SSH transport without exposing credentials", async (t) => {
  let attempts = 0;
  const trap = () => {
    attempts++;
    throw Error("transport tripwire");
  };
  t.mock.method(net, "connect", trap);
  t.mock.method(tls, "connect", trap);
  t.mock.method(ssh2.Client.prototype, "connect", trap);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const ssh = {
    host: "ssh.fixture.invalid",
    username: "fixture",
    password: "fixture-only",
    hostKeySHA256: "SHA256:" + "A".repeat(43),
  };
  for (const transport of [{}, { ssl: true }, { ssh }])
    for (const field of ["user", "password"])
      for (const value of [
        "private\ud800",
        "private\udfff",
        "private\ud800tail",
        "private\udfff\ud800",
        null,
        123,
        "x".repeat(8193),
      ]) {
        const config = {
          ...base,
          ...transport,
          user: "fixture-user",
          password: "fixture-password",
          [field]: value,
        };
        await assert.rejects(
          queryRedis({ ...config, command: ["GET", "key"] }),
          authError,
        );
        await assert.rejects(
          mutateRedis({
            ...config,
            allowWrite: true,
            command: ["SET", "key", "value"],
          }),
          authError,
        );
      }
  // Password-only AUTH follows the same policy, rather than a separate conversion path.
  await assert.rejects(
    queryRedis({ ...base, password: "private\ud800", command: ["GET", "key"] }),
    authError,
  );
  await assert.rejects(
    mutateRedis({
      ...base,
      password: "private\ud800",
      allowWrite: true,
      command: ["SET", "key", "value"],
    }),
    authError,
  );
  assert.equal(attempts, 0);
});

test("native Redis mutation refuses malformed AUTH before consuming dispatch authority", async (t) => {
  let attempts = 0;
  t.mock.method(net, "connect", () => {
    attempts++;
    throw Error("transport tripwire");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (const field of ["user", "password"]) {
    let dispatched = 0;
    const outcome = await observeNativeRedisSet(
      {
        ...base,
        user: "fixture",
        password: "fixture-only",
        [field]: "private\ud800",
        command: ["SET", "key", "value"],
      },
      {
        beforeDispatch() {
          dispatched++;
        },
      },
    );
    assert.deepEqual(outcome, { outcome: "not-sent", reason: "transport" });
    assert.equal(dispatched, 0);
    assert.equal(attempts, 0);
  }
});

test("valid Redis AUTH preserves exact Unicode bytes and existing omitted or empty field semantics for read and write", async (t) => {
  const batches = [];
  const server = net.createServer((socket) => {
    const batch = [];
    batches.push(batch);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = parseRESP(buffer);
        if (!frame) return;
        buffer = buffer.subarray(frame.bytes);
        const command = frame.value.map((b) => b.toString());
        batch.push(command);
        if (command[0] === "AUTH") socket.write("+OK\r\n");
        else if (command[0] === "GET") socket.end("$2\r\nok\r\n");
        else socket.end("+OK\r\n");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const cases = [
    [{}, null],
    [{ user: "", password: "" }, null],
    [{ password: "fixture" }, ["AUTH", "fixture"]],
    [{ user: "", password: "fixture" }, ["AUTH", "fixture"]],
    [{ user: "fixture" }, ["AUTH", "fixture", ""]],
    [{ user: "fixture", password: "" }, ["AUTH", "fixture", ""]],
    [
      { user: "中文🙂�\u0000", password: "密码🙂�\u0000" },
      ["AUTH", "中文🙂�\u0000", "密码🙂�\u0000"],
    ],
    [{ password: "x".repeat(8192) }, ["AUTH", "x".repeat(8192)]],
  ];
  for (const [auth, expected] of cases)
    for (const write of [false, true]) {
      const command = write ? ["SET", "key", "value"] : ["GET", "key"];
      const input = { ...base, port: server.address().port, ...auth, command };
      const result = write
        ? await mutateRedis({ ...input, allowWrite: true })
        : await queryRedis(input);
      assert.deepEqual(batches.at(-1), [
        ...(expected ? [expected] : []),
        command,
      ]);
      if (write) assert.equal(result.applied, true);
      else assert.deepEqual(result.rows, [{ value: "ok" }]);
    }
});
