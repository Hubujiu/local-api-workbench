// Pure state-machine tests. All net/TLS/SSH constructors are replaced before
// execution; no socket, server, app, SDK or subprocess is started here.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import ssh2 from "ssh2";
import { Duplex } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate as turn } from "node:timers/promises";
import {
  queryRedis,
  mutateRedis,
  parseRESP,
  observeNativeRedisSet,
} from "../src/redis.mjs";

const ssh = {
  host: "ssh.invalid",
  username: "fixture",
  password: "secret",
  hostKeySHA256: "SHA256:" + "A".repeat(43),
};
const input = {
  type: "redis",
  host: "redis.invalid",
  port: 6379,
  database: "2",
  password: "fixture",
  ssh,
  allowWrite: true,
  command: ["SET", "key", "value"],
};
function simulate(
  t,
  {
    holdSSH = false,
    holdCommand,
    reply = "+OK\r\n",
    deferClose = false,
    channelEOF = false,
    onCommand,
  } = {},
) {
  const state = {
    commands: [],
    streams: [],
    transports: [],
    wrappers: [],
    targets: [],
  };
  function stream(kind, speaks = false) {
    let release;
    const socket = new Duplex({
      autoDestroy: !(channelEOF && kind === "streams"),
      read() {},
      write(bytes, _encoding, done) {
        if (speaks) {
          const frame = parseRESP(bytes);
          assert.equal(frame.bytes, bytes.length);
          const args = frame.value.map((part) => part.toString());
          state.commands.push(args);
          onCommand?.(args);
          if (args[0] !== holdCommand)
            queueMicrotask(() =>
              socket.push(args[0] === "SET" ? reply : "+OK\r\n"),
            );
        }
        done();
      },
      destroy(error, done) {
        release = () => done(error);
        if (!deferClose) release();
      },
    });
    if (channelEOF && kind === "streams") {
      // Model ssh2's documented Duplex-like channel: destroy sends protocol
      // EOF, and close is emitted only after incoming EOF is consumed.
      socket.destroy = () => {
        socket.end();
        return socket;
      };
      socket.once("end", () => socket.emit("close"));
    }
    if (channelEOF && kind === "transports")
      socket.once("close", () =>
        state.streams.forEach((item) => item.socket.push(null)),
      );
    socket.on("error", () => {});
    const record = { socket, closed: false, release: () => release?.() };
    socket.once("close", () => (record.closed = true));
    state[kind].push(record);
    return socket;
  }
  t.mock.method(net, "connect", (config) => {
    const socket = stream(
      config.host === ssh.host ? "transports" : "streams",
      config.host !== ssh.host,
    );
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  t.mock.method(tls, "connect", (options) => {
    state.tlsOptions = options;
    const socket = stream("wrappers", true);
    queueMicrotask(() => socket.emit("secureConnect"));
    return socket;
  });
  t.mock.method(ssh2.Client.prototype, "connect", function (options) {
    state.sshOptions = options;
    state.ready = () => this.emit("ready");
    if (!holdSSH) queueMicrotask(() => this.emit("ready"));
    return this;
  });
  t.mock.method(
    ssh2.Client.prototype,
    "forwardOut",
    function (_address, _port, host, port, callback) {
      state.targets.push({ host, port });
      callback(null, stream("streams", true));
    },
  );
  t.mock.method(ssh2.Client.prototype, "destroy", function () {
    return this;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  state.assertClosed = () => {
    for (const item of [
      ...state.streams,
      ...state.transports,
      ...state.wrappers,
    ])
      assert(item.closed);
  };
  return state;
}
for (const ssl of [false, true]) {
  test(`pure Redis SSH ${ssl ? "TLS" : "channel"} dispatches once and owns all close receipts`, async (t) => {
    const s = simulate(t);
    const result = await mutateRedis({ ...input, ssl });
    assert.equal(result.applied, true);
    assert.deepEqual(
      s.commands.map((args) => args[0]),
      ["AUTH", "SELECT", "SET"],
    );
    assert.deepEqual(s.targets, [{ host: "redis.invalid", port: 6379 }]);
    assert.equal(s.transports.length, 1);
    s.assertClosed();
    if (ssl) {
      assert.equal(s.tlsOptions.socket, s.streams[0].socket);
      assert.equal(s.tlsOptions.host, "redis.invalid");
      assert.equal(s.tlsOptions.servername, "redis.invalid");
      assert.equal(s.tlsOptions.rejectUnauthorized, true);
    }
  });
}
test("pure TLS cleanup drains an SSH channel whose close requires consuming EOF", async (t) => {
  const s = simulate(t, { channelEOF: true });
  const result = await mutateRedis({ ...input, ssl: true });
  assert.equal(result.acknowledged, true);
  s.assertClosed();
});
test("pure Redis SSH completion waits for channel and transport independently without corrupting ACK", async (t) => {
  const s = simulate(t, { deferClose: true });
  let settled = false;
  const operation = mutateRedis(input).then((value) => {
    settled = true;
    return value;
  });
  await turn();
  assert.equal(s.commands.at(-1)[0], "SET");
  assert.equal(settled, false);
  s.streams[0].release();
  await turn();
  assert.equal(
    settled,
    false,
    "channel close alone does not release SSH ownership",
  );
  s.transports[0].release();
  assert.equal((await operation).acknowledged, true);
  s.assertClosed();
});
test("pure Redis read cancelled during close does not return a stale result", async (t) => {
  const s = simulate(t, { deferClose: true }),
    controller = new AbortController();
  const operation = queryRedis(
    { ...input, command: ["GET", "key"] },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(operation, {
    code: "DATABASE_QUERY_CANCELLED",
  });
  await turn();
  controller.abort();
  s.streams[0].release();
  s.transports[0].release();
  await rejected;
  s.assertClosed();
});
test("pure Redis deadline includes delayed SSH rather than restarting at AUTH", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = simulate(t, { holdSSH: true, holdCommand: "GET" });
  const operation = queryRedis({
    ...input,
    command: ["GET", "key"],
    timeoutMs: 1000,
  });
  const rejected = assert.rejects(operation, {
    code: "REDIS_OPERATION_DEADLINE",
  });
  t.mock.timers.tick(900);
  s.ready();
  await turn();
  assert.deepEqual(
    s.commands.map((args) => args[0]),
    ["AUTH", "SELECT", "GET"],
  );
  t.mock.timers.tick(100);
  await rejected;
  s.assertClosed();
});
for (const duringSSH of [false, true]) {
  test(`pure Redis first deadline reason survives SSH cancellation ${duringSSH ? "during setup" : "after dispatch"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const s = simulate(t, { holdSSH: duringSSH, holdCommand: "GET" });
    const operation = queryRedis({
      ...input,
      command: ["GET", "key"],
      timeoutMs: 10,
    });
    const rejected = assert.rejects(operation, {
      code: "REDIS_OPERATION_DEADLINE",
    });
    await turn();
    t.mock.timers.tick(99);
    await turn();
    assert.equal(s.transports[0].closed, false, "minimum budget is 100 ms");
    t.mock.timers.tick(1);
    await rejected;
    s.assertClosed();
    assert.equal(s.commands.length, duringSSH ? 0 : 3);
  });
}
test("pure Redis SSH maximum budget is shared with handshake, AUTH, SELECT and query", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = simulate(t, { holdCommand: "GET" });
  const operation = queryRedis({
    ...input,
    command: ["GET", "key"],
    timeoutMs: 99999,
  });
  const rejected = assert.rejects(operation, {
    code: "REDIS_OPERATION_DEADLINE",
  });
  await turn();
  t.mock.timers.tick(2999);
  await turn();
  assert.equal(s.transports[0].closed, false);
  t.mock.timers.tick(1);
  await rejected;
  s.assertClosed();
});
test("pure Redis SSH cancellation owns first reason and does not issue a later command", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController(),
    s = simulate(t, { holdCommand: "AUTH" });
  const operation = queryRedis(
    { ...input, command: ["GET", "key"] },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(operation, {
    code: "DATABASE_QUERY_CANCELLED",
  });
  await turn();
  controller.abort();
  t.mock.timers.tick(3000);
  await rejected;
  assert.deepEqual(
    s.commands.map((args) => args[0]),
    ["AUTH"],
  );
  s.assertClosed();
});
for (const reply of ["$-1\r\n", ":1\r\n"]) {
  test(`pure Redis SSH ${JSON.stringify(reply)} has no automatic replay`, async (t) => {
    const s = simulate(t, { reply });
    const operation = mutateRedis({
      ...input,
      command: [...input.command, "NX"],
    });
    if (reply === "$-1\r\n") assert.equal((await operation).applied, false);
    else await assert.rejects(operation, { code: "REDIS_WRITE_UNCERTAIN" });
    assert.equal(s.commands.filter((args) => args[0] === "SET").length, 1);
    s.assertClosed();
  });
}
test("pure native direct SET still drains acknowledgement after caller abort", async (t) => {
  const controller = new AbortController();
  const s = simulate(t, {
    onCommand(args) {
      if (args[0] === "SET") controller.abort();
    },
  });
  const result = await observeNativeRedisSet(
    { ...input, ssh: undefined },
    { signal: controller.signal, beforeDispatch() {} },
  );
  assert.equal(result.outcome, "acknowledged-applied");
  assert.equal(result.result.applied, true);
  assert.equal(s.transports.length, 0);
  assert.equal(s.commands.filter((args) => args[0] === "SET").length, 1);
  s.assertClosed();
});
