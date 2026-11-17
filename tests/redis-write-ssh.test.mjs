// CI-only network tests: independent RESP peers test transport semantics, not
// Redis application semantics. redis-ssh-integration.mjs uses the real service.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import ssh2 from "ssh2";
import http from "node:http";
import { channel } from "node:diagnostics_channel";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  mutateRedis,
  queryRedis,
  parseRESP,
  observeNativeRedisSet,
} from "../src/redis.mjs";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { createApp } from "../src/server.mjs";
import { startSSHFixture } from "./fixtures/ssh-server.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 2500;
  while (!predicate()) {
    assert(Date.now() < end, "expected protocol phase was reached");
    await delay(5);
  }
}
const base = {
  type: "redis",
  allowWrite: true,
  host: "redis.fixture",
  database: "2",
  password: "fictional-db-secret",
  command: ["SET", "fixture", "value"],
};
async function peer(
  t,
  { ssl = false, hold, reply = "+OK\r\n", reject, raw = false } = {},
) {
  const commands = [],
    sockets = new Set(),
    pending = [];
  let connections = 0;
  const protocol = (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    if (raw) return;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const frame = parseRESP(buffer);
      if (!frame) return;
      assert.equal(frame.bytes, buffer.length);
      buffer = Buffer.alloc(0);
      const args = frame.value.map((v) => v.toString());
      commands.push(args);
      const response =
        args[0] === reject
          ? "-ERR fixture rejection\r\n"
          : args[0] === "SET"
            ? reply
            : args[0] === "GET"
              ? "$7\r\nfixture\r\n"
              : "+OK\r\n";
      const send = () =>
        response === null ? socket.end() : socket.write(response);
      if (args[0] === hold) pending.push(send);
      else send();
    });
  };
  const ca = await readFile(
    new URL("./fixtures/localhost.crt", import.meta.url),
    "utf8",
  );
  const server = ssl
    ? tls.createServer(
        {
          allowHalfOpen: true,
          cert: ca,
          key: await readFile(
            new URL("./fixtures/localhost.key", import.meta.url),
          ),
        },
        protocol,
      )
    : net.createServer({ allowHalfOpen: true }, protocol);
  server.on("tlsClientError", () => {});
  server.on("connection", (socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    port: server.address().port,
    ca,
    commands,
    connections: () => connections,
    release: () => pending.splice(0).forEach((send) => send()),
  };
}
async function fixture(t, options = {}, sshOptions = {}) {
  const endpoint = await peer(t, options);
  const ssh = await startSSHFixture({
    targets: [
      { host: "redis.fixture", port: endpoint.port },
      { host: "localhost", port: endpoint.port },
      { host: "wrong-name.fixture", port: endpoint.port },
      { host: "redis.fixture", port: 6379, connectPort: endpoint.port },
    ],
    ...sshOptions,
  });
  t.after(() => ssh.close());
  return {
    ...endpoint,
    ...ssh,
    config: {
      ...base,
      port: endpoint.port,
      ssh: ssh.ssh,
      ...(options.ssl ? { ssl: true, ca: endpoint.ca, host: "localhost" } : {}),
    },
  };
}
// Observe the actual two cleanup boundaries (and the TLS wrapper, if any),
// rather than mistaking destroy() intent or server-side FIN for local close.
function observe(t, port) {
  const transports = [],
    streams = [],
    wrappers = [];
  const record = (list, socket) => {
    const item = { socket, closed: false };
    list.push(item);
    socket.once("close", () => (item.closed = true));
  };
  const onSocket = ({ socket }) =>
    socket.once("connect", () => {
      if (socket.remotePort === port) record(transports, socket);
    });
  channel("net.client.socket").subscribe(onSocket);
  t.after(() => channel("net.client.socket").unsubscribe(onSocket));
  const forward = ssh2.Client.prototype.forwardOut;
  t.mock.method(ssh2.Client.prototype, "forwardOut", function (...args) {
    const callback = args.pop();
    return forward.call(this, ...args, (error, stream) => {
      if (stream) record(streams, stream);
      callback(error, stream);
    });
  });
  const connect = tls.connect;
  t.mock.method(tls, "connect", function (...args) {
    const socket = connect.apply(this, args);
    record(wrappers, socket);
    return socket;
  });
  return {
    transports,
    streams,
    wrappers,
    assertClosed(count = 1) {
      assert.equal(transports.length, count, "no reconnect or direct fallback");
      for (const item of [...transports, ...streams, ...wrappers])
        assert(
          item.closed,
          "settlement waits for actual owned stream and SSH closes",
        );
    },
  };
}
for (const ssl of [false, true]) {
  test(
    `Redis pinned SSH ${ssl ? "TLS" : "plain"} password/key GET, SET ACK and target identity`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t, { ssl });
      const owned = observe(t, f.ssh.port);
      const key = {
        ...f.ssh,
        privateKey: f.encryptedPrivateKey,
        passphrase: "fixture-key-passphrase",
      };
      delete key.password;
      for (const ssh of [f.ssh, key]) {
        const read = await queryRemoteDatabase({
          ...f.config,
          ssh,
          command: ["GET", "fixture"],
        });
        assert.equal(read.rows[0].value, "fixture");
        assert.equal((await mutateRedis({ ...f.config, ssh })).applied, true);
      }
      owned.assertClosed(4);
      assert.equal(owned.streams.length, 4);
      assert.equal(owned.wrappers.length, ssl ? 4 : 0);
      assert.deepEqual(
        f.stats.forwarded,
        Array(4).fill({
          host: ssl ? "localhost" : "redis.fixture",
          port: f.port,
        }),
      );
      assert.deepEqual(
        f.commands.map((c) => c[0]),
        [
          "AUTH",
          "SELECT",
          "GET",
          "AUTH",
          "SELECT",
          "SET",
          "AUTH",
          "SELECT",
          "GET",
          "AUTH",
          "SELECT",
          "SET",
        ],
      );
    },
  );
  for (const reply of ["$-1\r\n", null, ":1\r\n"]) {
    test(
      `Redis SSH ${ssl ? "TLS" : "plain"} ${JSON.stringify(reply)} retains ACK/noop or uncertainty with no replay`,
      { timeout: 10000 },
      async (t) => {
        const f = await fixture(t, { ssl, reply });
        const owned = observe(t, f.ssh.port);
        const operation = mutateRedis({
          ...f.config,
          command: [...base.command, "NX"],
        });
        if (reply === "$-1\r\n") {
          const result = await operation;
          assert.equal(result.acknowledged, true);
          assert.equal(result.applied, false);
          assert.equal(result.affectedKeys, 0);
        } else
          await assert.rejects(operation, { code: "REDIS_WRITE_UNCERTAIN" });
        owned.assertClosed();
        assert.deepEqual(
          f.commands.map((c) => c[0]),
          ["AUTH", "SELECT", "SET"],
        );
      },
    );
  }
}
test("Redis SSH uses the Redis default port without resolving the logical name locally", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await queryRedis({
        ...f.config,
        port: undefined,
        command: ["GET", "fixture"],
      })
    ).rows[0].value,
    "fixture",
  );
  assert.deepEqual(f.stats.forwarded, [{ host: "redis.fixture", port: 6379 }]);
});
test(
  "Redis wrong SSH pin, authentication or forwarding never sends Redis credentials or falls back direct",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const owned = observe(t, f.ssh.port);
    await assert.rejects(
      mutateRedis({
        ...f.config,
        ssh: { ...f.ssh, hostKeySHA256: "SHA256:" + "A".repeat(43) },
      }),
      /SSH/,
    );
    assert.equal(f.stats.authenticationAttempts, 0);
    await assert.rejects(
      queryRedis({
        ...f.config,
        command: ["GET", "fixture"],
        ssh: { ...f.ssh, password: "wrong" },
      }),
      /SSH/,
    );
    assert.equal(f.stats.forwarded.length, 0);
    await assert.rejects(
      mutateRedis({ ...f.config, host: "forbidden.fixture" }),
      /转发/,
    );
    owned.assertClosed(3);
    assert.equal(f.connections(), 0);
    assert.deepEqual(f.commands, []);
  },
);
test(
  "Redis SSH TLS validates the logical database CA and hostname before AUTH",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { ssl: true });
    const owned = observe(t, f.ssh.port);
    await assert.rejects(
      mutateRedis({ ...f.config, ca: tls.rootCertificates[0] }),
      /certificate|self.signed|证书/i,
    );
    await assert.rejects(
      mutateRedis({ ...f.config, host: "wrong-name.fixture" }),
      /hostname|altnames|证书/i,
    );
    await assert.rejects(
      mutateRedis({ ...f.config, host: "127.0.0.1" }),
      /DNS/,
    );
    owned.assertClosed(2);
    assert.deepEqual(f.commands, []);
  },
);
for (const hold of ["AUTH", "SELECT", "GET"]) {
  for (const cancellation of [true, false]) {
    test(
      `Redis SSH ${hold} ${cancellation ? "cancel" : "total deadline"} prevents subsequent commands and closes both transports`,
      { timeout: 10000 },
      async (t) => {
        const f = await fixture(t, { hold });
        const owned = observe(t, f.ssh.port),
          controller = new AbortController();
        const operation = queryRedis(
          { ...f.config, timeoutMs: 1000, command: ["GET", "fixture"] },
          { signal: controller.signal },
        );
        const rejected = assert.rejects(operation, {
          code: cancellation
            ? "DATABASE_QUERY_CANCELLED"
            : "REDIS_OPERATION_DEADLINE",
        });
        await until(() => f.commands.some((c) => c[0] === hold));
        if (cancellation) controller.abort();
        await rejected;
        owned.assertClosed();
        const count = f.commands.length;
        f.release();
        await delay(20);
        assert.equal(f.commands.length, count);
        assert.deepEqual(
          f.commands.map((c) => c[0]),
          ["AUTH", "SELECT", "GET"].slice(
            0,
            ["AUTH", "SELECT", "GET"].indexOf(hold) + 1,
          ),
        );
      },
    );
  }
}
for (const stage of ["AUTH", "SELECT", "SET"]) {
  test(`Redis SSH ${stage} protocol rejection preserves the pre/post SET outcome boundary`, async (t) => {
    const f = await fixture(t, { reject: stage });
    const owned = observe(t, f.ssh.port);
    await assert.rejects(mutateRedis(f.config), (error) => {
      assert.equal(error.code === "REDIS_WRITE_UNCERTAIN", stage === "SET");
      return true;
    });
    owned.assertClosed();
    assert.deepEqual(
      f.commands.map((c) => c[0]),
      ["AUTH", "SELECT", "SET"].slice(
        0,
        ["AUTH", "SELECT", "SET"].indexOf(stage) + 1,
      ),
    );
  });
}
test(
  "Redis SSH lost SET ACK reaches one total deadline, closes and never replays",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { hold: "SET" });
    const owned = observe(t, f.ssh.port);
    await assert.rejects(mutateRedis({ ...f.config, timeoutMs: 1000 }), {
      code: "REDIS_WRITE_UNCERTAIN",
    });
    owned.assertClosed();
    assert.deepEqual(
      f.commands.map((c) => c[0]),
      ["AUTH", "SELECT", "SET"],
    );
  },
);
for (const stage of ["ssh-handshake", "ssh-auth", "ssh-forward", "tls"]) {
  for (const cancellation of [false, true]) {
    test(
      `Redis ${stage} ${cancellation ? "cancel" : "deadline"} belongs to the Redis budget before AUTH`,
      { timeout: 10000 },
      async (t) => {
        const f = await fixture(
          t,
          ["tls", "ssh-handshake"].includes(stage) ? { raw: true } : {},
          {
            holdAuthentication: stage === "ssh-auth",
            holdForward: stage === "ssh-forward",
          },
        );
        let config = {
          ...f.config,
          timeoutMs: 1000,
          command: ["GET", "fixture"],
        };
        if (stage === "ssh-handshake") config.ssh = { ...f.ssh, port: f.port };
        if (stage === "tls")
          config = { ...config, ssl: true, host: "localhost", ca: f.ca };
        const controller = new AbortController(),
          owned = observe(t, config.ssh.port);
        const began = performance.now();
        const operation = queryRedis(config, { signal: controller.signal });
        const rejection = assert.rejects(operation, {
          code: cancellation
            ? "DATABASE_QUERY_CANCELLED"
            : "REDIS_OPERATION_DEADLINE",
        });
        if (cancellation) {
          await until(() =>
            stage === "ssh-handshake"
              ? f.connections() > 0
              : stage === "ssh-auth"
                ? f.stats.authenticationAttempts > 0
                : stage === "ssh-forward"
                  ? f.stats.forwarded.length > 0
                  : f.connections() > 0,
          );
          controller.abort();
        }
        await rejection;
        assert(
          performance.now() - began < 2500,
          "SSH must not add a separate 3s/8s budget",
        );
        owned.assertClosed();
        assert.deepEqual(f.commands, []);
      },
    );
  }
}
test(
  "Redis SSH shared five-operation cap is reclaimed after cancellation without closing another operation",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { hold: "GET" });
    const owned = observe(t, f.ssh.port),
      controllers = Array.from({ length: 5 }, () => new AbortController());
    const operations = controllers.map((c) =>
      queryRedis(
        { ...f.config, command: ["GET", "fixture"] },
        { signal: c.signal },
      ),
    );
    const cancelled = assert.rejects(operations[0], {
      code: "DATABASE_QUERY_CANCELLED",
    });
    await until(() => f.commands.filter((c) => c[0] === "GET").length === 5);
    await assert.rejects(
      queryRedis({ ...f.config, command: ["GET", "fixture"] }),
      /最多5/,
    );
    controllers[0].abort();
    await cancelled;
    const replacement = queryRedis({
      ...f.config,
      command: ["GET", "fixture"],
    });
    await until(() => f.commands.filter((c) => c[0] === "GET").length === 6);
    f.release();
    const results = await Promise.all([...operations.slice(1), replacement]);
    assert(results.every((result) => result.rows[0].value === "fixture"));
    owned.assertClosed(6);
  },
);
test(
  "Redis SSH sessions isolate projects, revoke active reads and keep native SET unsupported",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { hold: "GET" }),
      sessions = new DatabaseSessions();
    t.after(() => sessions.close());
    const grant = sessions.register("p", {
      ...f.config,
      name: "Ephemeral Redis SSH",
    });
    assert.doesNotMatch(
      JSON.stringify(sessions.list("p")),
      /fixture-only-password|fictional-db-secret|hostKeySHA256/,
    );
    await assert.rejects(
      sessions.query("q", { connectionId: grant.id, sql: '["GET","fixture"]' }),
      /未授权/,
    );
    await assert.rejects(sessions.captureNativeRedisTarget("p", grant.id), {
      code: "NATIVE_WRITE_TARGET_INVALID",
    });
    assert.equal(f.stats.connections, 0);
    const owned = observe(t, f.ssh.port);
    const operation = sessions.query("p", {
      connectionId: grant.id,
      sql: '["GET","fixture"]',
    });
    const revoked = assert.rejects(operation, /撤销/);
    await until(() => f.commands.some((c) => c[0] === "GET"));
    sessions.revoke("p", grant.id);
    await revoked;
    owned.assertClosed();
    assert.deepEqual(sessions.list("p"), []);
    await assert.rejects(
      sessions.query("p", { connectionId: grant.id, sql: '["GET","fixture"]' }),
      /未授权/,
    );
    assert.deepEqual(
      await observeNativeRedisSet(f.config, {
        beforeDispatch() {
          throw Error("must not run");
        },
      }),
      { outcome: "not-sent", reason: "transport" },
    );
  },
);
test(
  "owner HTTP Redis SSH write permission is one-shot and credentials are not persisted",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "redis-ssh-owner-"));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const f = await fixture(t),
      project = await app.store.create("Redis SSH"),
      before = await app.store.get(project.id);
    const send = async (body, token = app.token) => {
      const res = await fetch(
        app.url + "/api/projects/" + project.id + "/database",
        {
          method: "POST",
          headers: {
            "x-local-token": token,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      return { status: res.status, value: await res.json() };
    };
    assert.equal((await send(f.config, "not-the-owner")).status, 403);
    assert.equal((await send({ ...f.config, allowWrite: false })).status, 400);
    assert.equal(f.stats.connections, 0);
    const allowed = await send(f.config);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.value.applied, true);
    assert.equal((await send({ ...f.config, allowWrite: false })).status, 400);
    assert.equal(f.stats.connections, 1);
    assert.deepEqual(await app.store.get(project.id), before);
  },
);
for (const writing of [false, true]) {
  test(
    `owner HTTP disconnect ${writing ? "does not cancel dispatched SET acknowledgement" : "cancels Redis SSH read"}`,
    { timeout: 15000 },
    async (t) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "redis-ssh-disconnect-"),
      );
      const app = await createApp({ root, port: 0 });
      t.after(async () => {
        app.server.closeAllConnections();
        await new Promise((r) => app.server.close(r));
        await rm(root, { recursive: true, force: true });
      });
      const f = await fixture(t, { hold: writing ? "SET" : "GET" }),
        project = await app.store.create("Disconnect");
      const owned = observe(t, f.ssh.port);
      const request = http.request(
        app.url + "/api/projects/" + project.id + "/database",
        {
          method: "POST",
          headers: {
            "x-local-token": app.token,
            "content-type": "application/json",
          },
        },
      );
      request.on("error", () => {});
      request.end(
        JSON.stringify({
          ...f.config,
          allowWrite: writing,
          command: writing ? base.command : ["GET", "fixture"],
        }),
      );
      await until(() =>
        f.commands.some((c) => c[0] === (writing ? "SET" : "GET")),
      );
      request.destroy();
      if (writing) {
        await delay(50);
        assert.equal(owned.transports[0].closed, false);
        f.release();
      }
      await until(() => owned.transports.every((item) => item.closed));
      owned.assertClosed();
      assert.equal(
        f.commands.filter((c) => c[0] === (writing ? "SET" : "GET")).length,
        1,
      );
    },
  );
}
