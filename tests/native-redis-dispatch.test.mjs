// Independent TCP/TLS peers prove dispatch/ownership, not remote durability.
// Runtime execution belongs to ordinary CI; no original application is used.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { channel } from "node:diagnostics_channel";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { observeNativeRedisSet, parseRESP } from "../src/redis.mjs";

function observe(t, port) {
  const clients = [];
  const listener = ({ socket }) =>
    socket.once("connect", () => {
      if (socket.remotePort !== port) return;
      const record = { socket, closed: false };
      socket.once("close", () => {
        record.closed = true;
      });
      clients.push(record);
    });
  channel("net.client.socket").subscribe(listener);
  t.after(() => channel("net.client.socket").unsubscribe(listener));
  return clients;
}
function assertClosed(clients, count = 1) {
  assert.equal(
    clients.length,
    count,
    "exactly one transport, without reconnect",
  );
  assert(
    clients.every(({ socket, closed }) => closed && socket.destroyed),
    "terminal result follows actual local close, not merely destroy intent",
  );
}
async function peer(t, { ssl = false, hold, reply = "+OK\r\n" } = {}) {
  const sockets = [],
    commands = [];
  let reach, release;
  const reached = new Promise((resolve) => {
    reach = resolve;
  });
  const protocol = (socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      const frame = parseRESP(bytes);
      if (!frame) return;
      assert.equal(
        frame.bytes,
        bytes.length,
        "no pipelined or additional commands",
      );
      bytes = Buffer.alloc(0);
      const command = frame.value.map((value) => value.toString());
      commands.push(command);
      const response = command[0] === "SET" ? reply : "+OK\r\n";
      release = () =>
        response === null ? socket.end() : socket.write(response);
      if (command[0] === hold) reach();
      else {
        release();
        if (command[0] === "SET") reach();
      }
    });
  };
  let cert;
  const server = ssl
    ? tls.createServer(
        {
          allowHalfOpen: true,
          cert: (cert = await readFile(
            new URL("./fixtures/localhost.crt", import.meta.url),
            "utf8",
          )),
          key: await readFile(
            new URL("./fixtures/localhost.key", import.meta.url),
          ),
        },
        protocol,
      )
    : net.createServer({ allowHalfOpen: true }, protocol);
  server.on("tlsClientError", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    config: {
      type: "redis",
      host: "127.0.0.1",
      port: server.address().port,
      database: "2",
      password: "fictional-secret",
      command: ["SET", "fixture", "value"],
      ssl,
      ...(ssl ? { ca: cert } : {}),
    },
    commands,
    reached,
    release: () => release(),
  };
}
const commandNames = (f) => f.commands.map((command) => command[0]);
for (const ssl of [false, true]) {
  const transport = ssl ? "TLS" : "plain";
  test(
    `native SET ${transport}: already cancelled means zero connection and zero dispatch`,
    { timeout: 10000 },
    async (t) => {
      const f = await peer(t, { ssl });
      const clients = observe(t, f.config.port),
        controller = new AbortController();
      controller.abort();
      let calls = 0;
      assert.deepEqual(
        await observeNativeRedisSet(f.config, {
          signal: controller.signal,
          beforeDispatch: () => {
            calls++;
          },
        }),
        { outcome: "not-sent", reason: "cancelled" },
      );
      assertClosed(clients, 0);
      assert.deepEqual(f.commands, []);
      assert.equal(calls, 0);
    },
  );
  for (const stage of ["AUTH", "SELECT"]) {
    test(
      `native SET ${transport}: cancellation while ${stage} waits forbids SET`,
      { timeout: 10000 },
      async (t) => {
        const f = await peer(t, { ssl, hold: stage });
        const clients = observe(t, f.config.port),
          controller = new AbortController();
        let calls = 0;
        const pending = observeNativeRedisSet(f.config, {
          signal: controller.signal,
          beforeDispatch: () => {
            calls++;
          },
        });
        await f.reached;
        controller.abort();
        assert.deepEqual(await pending, {
          outcome: "not-sent",
          reason: "cancelled",
        });
        assertClosed(clients);
        assert.deepEqual(
          commandNames(f),
          stage === "AUTH" ? ["AUTH"] : ["AUTH", "SELECT"],
        );
        assert.equal(calls, 0);
      },
    );
  }
  test(
    `native SET ${transport}: final generation guard rejects after SELECT with no dispatch`,
    { timeout: 10000 },
    async (t) => {
      const f = await peer(t, { ssl, hold: "SELECT" });
      const clients = observe(t, f.config.port);
      let live = true,
        calls = 0;
      const pending = observeNativeRedisSet(f.config, {
        beforeDispatch() {
          calls++;
          if (!live)
            throw Object.assign(
              Error("fictional private revoke details must not escape"),
              { code: "NATIVE_WRITE_REVOKED" },
            );
        },
      });
      await f.reached;
      live = false;
      f.release();
      assert.deepEqual(await pending, {
        outcome: "not-sent",
        reason: "revoked",
      });
      assertClosed(clients);
      assert.equal(calls, 1);
      assert.deepEqual(commandNames(f), ["AUTH", "SELECT"]);
    },
  );
  test(
    `native SET ${transport}: dispatched cancellation drains late ACK exactly once`,
    { timeout: 10000 },
    async (t) => {
      const f = await peer(t, { ssl, hold: "SET" });
      const clients = observe(t, f.config.port),
        controller = new AbortController();
      let calls = 0,
        settled = false;
      const pending = observeNativeRedisSet(f.config, {
        signal: controller.signal,
        beforeDispatch: () => {
          calls++;
        },
      });
      pending.then(() => {
        settled = true;
      });
      await f.reached;
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        settled,
        false,
        "abort must not discard the dispatched operation observer",
      );
      assert.equal(clients[0].closed, false);
      f.release();
      const result = await pending;
      assertClosed(clients);
      assert.equal(result.outcome, "acknowledged-applied");
      assert.equal(result.reason, "acknowledged");
      assert.equal(result.result.applied, true);
      assert.deepEqual(result.result.rows, [{ value: "OK" }]);
      assert.equal(calls, 1);
      assert.deepEqual(commandNames(f), ["AUTH", "SELECT", "SET"]);
    },
  );
  test(
    `native SET ${transport}: ACK latched before local close survives cancellation at close`,
    { timeout: 10000 },
    async (t) => {
      const f = await peer(t, { ssl, hold: "SET" });
      const clients = observe(t, f.config.port),
        controller = new AbortController();
      const pending = observeNativeRedisSet(f.config, {
        signal: controller.signal,
        beforeDispatch() {},
      });
      await f.reached;
      clients[0].socket.once("close", () => controller.abort());
      f.release();
      const result = await pending;
      assertClosed(clients);
      assert.equal(controller.signal.aborted, true);
      assert.equal(result.outcome, "acknowledged-applied");
      assert.deepEqual(commandNames(f), ["AUTH", "SELECT", "SET"]);
    },
  );
  for (const stage of ["AUTH", "SELECT"]) {
    test(
      `native SET ${transport}: pre-dispatch ${stage} deadline cannot consume the slot`,
      { timeout: 10000 },
      async (t) => {
        const f = await peer(t, { ssl, hold: stage }),
          clients = observe(t, f.config.port);
        let calls = 0;
        const result = await observeNativeRedisSet(
          { ...f.config, timeoutMs: 100 },
          {
            beforeDispatch() {
              calls++;
            },
          },
        );
        assertClosed(clients);
        assert.deepEqual(result, { outcome: "not-sent", reason: "deadline" });
        assert.equal(calls, 0);
        assert.equal(
          f.commands.some((command) => command[0] === "SET"),
          false,
        );
      },
    );
  }
  for (const [name, reply] of [
    ["EOF", null],
    ["malformed ACK", ":1\r\n"],
    ["error", "-ERR fictional private details\r\n"],
  ]) {
    test(
      `native SET ${transport}: post-dispatch cancellation plus ${name} stays unknown and sanitized`,
      { timeout: 10000 },
      async (t) => {
        const f = await peer(t, { ssl, hold: "SET", reply });
        const clients = observe(t, f.config.port),
          controller = new AbortController();
        let calls = 0;
        const pending = observeNativeRedisSet(f.config, {
          signal: controller.signal,
          beforeDispatch: () => {
            calls++;
          },
        });
        await f.reached;
        controller.abort();
        f.release();
        assert.deepEqual(await pending, {
          outcome: "unknown",
          reason: "cancelled",
        });
        assertClosed(clients);
        assert.equal(calls, 1);
        assert.deepEqual(commandNames(f), ["AUTH", "SELECT", "SET"]);
      },
    );
  }
}
test(
  "native SET guard and conservative socket.write attempt share one synchronous turn",
  { timeout: 10000 },
  async (t) => {
    const f = await peer(t),
      clients = observe(t, f.config.port);
    const events = [];
    const listener = ({ socket }) =>
      socket.once("connect", () => {
        if (socket.remotePort !== f.config.port) return;
        const write = socket.write;
        socket.write = function (chunk, ...rest) {
          const frame = Buffer.isBuffer(chunk) ? parseRESP(chunk) : undefined;
          if (frame?.value?.[0]?.toString() === "SET")
            events.push("socket-write");
          return write.call(this, chunk, ...rest);
        };
      });
    channel("net.client.socket").subscribe(listener);
    t.after(() => channel("net.client.socket").unsubscribe(listener));
    const result = await observeNativeRedisSet(f.config, {
      beforeDispatch() {
        events.push("consume");
        queueMicrotask(() => events.push("microtask"));
      },
    });
    assertClosed(clients);
    assert.equal(result.outcome, "acknowledged-applied");
    assert.deepEqual(events, ["consume", "socket-write", "microtask"]);
  },
);
test(
  "native SET cancellation at two seconds does not restart the existing three-second Redis deadline",
  { timeout: 10000 },
  async (t) => {
    const f = await peer(t, { hold: "SET" }),
      clients = observe(t, f.config.port);
    const controller = new AbortController();
    const start = performance.now();
    const pending = observeNativeRedisSet(f.config, {
      signal: controller.signal,
      beforeDispatch() {},
    });
    await f.reached;
    await delay(2000);
    controller.abort();
    assert.deepEqual(await pending, {
      outcome: "unknown",
      reason: "deadline",
    });
    const elapsed = performance.now() - start;
    assertClosed(clients);
    assert(elapsed >= 2700, "original default deadline remains in force");
    assert(
      elapsed < 4800,
      "no new three-second window begins at caller cancellation",
    );
    assert.deepEqual(commandNames(f), ["AUTH", "SELECT", "SET"]);
  },
);

for (const mode of ["abort-return", "async-return", "async-reject-return"]) {
  test(
    `native SET rejects ${mode} final guard without sending a command`,
    { timeout: 10000 },
    async (t) => {
      const f = await peer(t),
        clients = observe(t, f.config.port);
      const controller = new AbortController();
      let calls = 0;
      const result = await observeNativeRedisSet(f.config, {
        signal: controller.signal,
        beforeDispatch() {
          calls++;
          if (mode === "abort-return") controller.abort();
          else if (mode === "async-return") return Promise.resolve();
          else return Promise.reject(Error("rejected guard must be observed"));
        },
      });
      assertClosed(clients);
      assert.deepEqual(result, {
        outcome: "not-sent",
        reason: mode === "abort-return" ? "cancelled" : "transport",
      });
      assert.equal(calls, 1);
      assert.deepEqual(commandNames(f), ["AUTH", "SELECT"]);
    },
  );
}
