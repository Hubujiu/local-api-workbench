// Real sockets and independent protocol peers establish local ownership only;
// real Redis application/TTL behavior is checked by redis-integration.mjs in CI.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import { channel } from "node:diagnostics_channel";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateRedis, parseRESP } from "../src/redis.mjs";
import { createApp } from "../src/server.mjs";

const base = {
  type: "redis",
  allowWrite: true,
  host: "127.0.0.1",
  database: "2",
  password: "fictional",
  command: ["SET", "fixture", "value"],
};
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
function closed(clients, count = 1) {
  assert.equal(clients.length, count);
  assert(
    clients.every((r) => r.closed && r.socket.destroyed),
    "write settlement must follow actual owned local close, not destroy intent",
  );
}
async function peer(t, { ssl = false, reply = "+OK\r\n", hold, reject } = {}) {
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
      assert.equal(frame.bytes, bytes.length);
      bytes = Buffer.alloc(0);
      const command = frame.value.map((v) => v.toString());
      commands.push(command);
      const response =
        command[0] === reject
          ? "-ERR fictional rejection\r\n"
          : command[0] === "SET"
            ? reply
            : "+OK\r\n";
      release = () =>
        response === null ? socket.end() : socket.write(response);
      if (command[0] === hold) reach();
      else {
        release();
        if (command[0] === "SET" || command[0] === reject) reach();
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
      ...base,
      port: server.address().port,
      ssl,
      ...(ssl ? { ca: cert } : {}),
    },
    commands,
    sockets,
    reached,
    release: () => release(),
  };
}
for (const ssl of [false, true]) {
  for (const conditional of [false, true]) {
    test(
      `Redis ${ssl ? "TLS" : "plain"} ${conditional ? "conditional no-op" : "SET ACK"} waits for local close against a half-open peer`,
      { timeout: 10000 },
      async (t) => {
        const f = await peer(t, {
          ssl,
          reply: conditional ? "$-1\r\n" : "+OK\r\n",
        });
        const clients = observe(t, f.config.port);
        const result = await mutateRedis({
          ...f.config,
          command: [...base.command, ...(conditional ? ["NX"] : [])],
        });
        closed(clients);
        assert.equal(result.acknowledged, true);
        assert.equal(result.applied, !conditional);
        assert.equal(result.affectedKeys, conditional ? 0 : 1);
        assert.deepEqual(
          f.commands.map((c) => c[0]),
          ["AUTH", "SELECT", "SET"],
        );
        assert(
          f.sockets.every((s) => !s.writableEnded),
          "peer never sends FIN to unblock cleanup",
        );
      },
    );
  }
  for (const reply of [null, ":1\r\n"]) {
    test(
      `Redis ${ssl ? "TLS" : "plain"} ${reply === null ? "EOF without ACK" : "malformed ACK"} closes before uncertainty without replay`,
      { timeout: 10000 },
      async (t) => {
        const f = await peer(t, { ssl, reply });
        const clients = observe(t, f.config.port);
        await assert.rejects(mutateRedis(f.config), {
          code: "REDIS_WRITE_UNCERTAIN",
        });
        closed(clients);
        assert.deepEqual(
          f.commands.map((c) => c[0]),
          ["AUTH", "SELECT", "SET"],
        );
      },
    );
  }
  for (const stage of ["AUTH", "SELECT", "SET"]) {
    test(
      `Redis ${ssl ? "TLS" : "plain"} ${stage} error retains outcome and closes before rejection`,
      { timeout: 10000 },
      async (t) => {
        const f = await peer(t, { ssl, reject: stage });
        const clients = observe(t, f.config.port);
        await assert.rejects(mutateRedis(f.config), (error) => {
          assert.equal(error.code === "REDIS_WRITE_UNCERTAIN", stage === "SET");
          return true;
        });
        closed(clients);
        assert.deepEqual(
          f.commands.map((c) => c[0]),
          ["AUTH", "SELECT", "SET"].slice(
            0,
            ["AUTH", "SELECT", "SET"].indexOf(stage) + 1,
          ),
        );
      },
    );
  }
}
test(
  "Redis default three-second SET deadline closes before uncertainty and never reconnects or replays",
  { timeout: 10000 },
  async (t) => {
    const f = await peer(t, { hold: "SET" });
    const clients = observe(t, f.config.port);
    const start = performance.now();
    await assert.rejects(mutateRedis(f.config), {
      code: "REDIS_WRITE_UNCERTAIN",
    });
    closed(clients);
    assert(
      performance.now() - start >= 2700,
      "retain the existing default budget",
    );
    assert.equal(f.commands.filter((c) => c[0] === "SET").length, 1);
  },
);
test(
  "Redis pre-SET deadlines send no later command and preserve an unrelated active write",
  { timeout: 10000 },
  async (t) => {
    const other = await peer(t, { hold: "SET" });
    const otherClients = observe(t, other.config.port);
    const active = mutateRedis(other.config);
    active.catch(() => {});
    await other.reached;
    for (const stage of ["AUTH", "SELECT"]) {
      const f = await peer(t, { hold: stage });
      const clients = observe(t, f.config.port);
      await assert.rejects(
        mutateRedis({ ...f.config, timeoutMs: 100 }),
        (error) => {
          assert.notEqual(error.code, "REDIS_WRITE_UNCERTAIN");
          return true;
        },
      );
      closed(clients);
      assert.equal(
        f.commands.some((c) => c[0] === "SET"),
        false,
      );
      assert.equal(otherClients[0].closed, false);
    }
    other.release();
    assert.equal((await active).applied, true);
    closed(otherClients);
  },
);
test(
  "owner HTTP disconnect does not cancel an authorized Redis write or persist credentials",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "redis-owner-close-"));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    const project = await app.store.create("Fictional Redis write");
    const before = await app.store.get(project.id);
    const f = await peer(t, { hold: "SET" });
    const clients = observe(t, f.config.port);
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
    t.after(() => request.destroy());
    request.end(JSON.stringify(f.config));
    await f.reached;
    const disconnected = new Promise((resolve) =>
      request.once("close", resolve),
    );
    request.destroy();
    await disconnected;
    assert.equal(clients[0].closed, false);
    const locallyClosed = new Promise((resolve) =>
      clients[0].socket.once("close", resolve),
    );
    f.release();
    await locallyClosed;
    closed(clients);
    assert.equal(f.commands.filter((c) => c[0] === "SET").length, 1);
    assert.deepEqual(await app.store.get(project.id), before);
  },
);
