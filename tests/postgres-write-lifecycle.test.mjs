import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { channel } from "node:diagnostics_channel";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createApp } from "../src/server.mjs";
import { mutatePostgres } from "../src/postgres-write.mjs";
import { openDatabaseSSH } from "../src/database-ssh.mjs";
import { startPostgresWritePeer } from "./fixtures/postgres-write-peer.mjs";
import { startSSHFixture } from "./fixtures/ssh-server.mjs";

const input = {
  type: "postgres",
  allowWrite: true,
  host: "127.0.0.1",
  user: "fictional",
  database: "fixture",
  password: "",
  sql: "INSERT INTO entries(value) VALUES ($1)",
  parameters: ["fictional-value"],
};
async function bounded(promise, label, milliseconds = 1500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Fixture deadline: " + label)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function observe(t, port) {
  const clients = [],
    events = channel("net.client.socket");
  const listener = ({ socket }) =>
    socket.once("connect", () => {
      if (socket.remotePort !== port) return;
      const record = { socket, closed: false };
      socket.once("close", () => {
        record.closed = true;
      });
      clients.push(record);
    });
  events.subscribe(listener);
  t.after(() => events.unsubscribe(listener));
  return clients;
}
function assertClosed(clients, expected = 1) {
  assert.equal(clients.length, expected);
  assert(clients.every(({ socket, closed }) => closed && socket.destroyed));
}
async function ownerHTTP(t) {
  const root = await mkdtemp(path.join(tmpdir(), "postgres-write-lifecycle-")),
    app = await createApp({ root, port: 0 }),
    project = await app.store.create("Fictional PostgreSQL lifecycle"),
    other = await app.store.create("Unrelated project");
  const before = await app.store.get(project.id),
    beforeOther = await app.store.get(other.id);
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    send(value) {
      let request;
      const response = new Promise((resolve, reject) => {
        request = http.request(
          app.url + "/api/projects/" + project.id + "/database",
          {
            method: "POST",
            headers: {
              "x-local-token": app.token,
              "content-type": "application/json",
            },
          },
          (res) => {
            let text = "";
            res.on("data", (chunk) => {
              text += chunk;
            });
            res.on("end", () =>
              resolve({ status: res.statusCode, data: JSON.parse(text) }),
            );
            res.on("error", reject);
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify(value));
      });
      response.catch(() => {});
      t.after(() => request.destroy());
      return { request, response };
    },
    async assertUnchanged() {
      assert.deepEqual(await app.store.get(project.id), before);
      assert.deepEqual(await app.store.get(other.id), beforeOther);
    },
  };
}

for (const ssl of [false, true])
  for (const mode of ["commit", "rollback"])
    test(
      `PostgreSQL ${ssl ? "TLS" : "plain"} ${mode} ACK survives a half-open peer and HTTP returns only after local close`,
      { timeout: 10000 },
      async (t) => {
        const peer = await startPostgresWritePeer({ mode, ssl });
        t.after(() => peer.close());
        const clients = observe(t, peer.port),
          owner = await ownerHTTP(t);
        const { response } = owner.send({
          ...input,
          port: peer.port,
          ssl,
          ...(ssl ? { host: "localhost", ca: peer.cert } : {}),
        });
        await bounded(peer.reached, "terminal ACK");
        const result = await bounded(response, "HTTP after ACK");
        assertClosed(clients);
        assert(
          peer.sockets.every((socket) => !socket.writableEnded),
          "fixture never sends FIN or closes its write half to unblock cleanup",
        );
        assert.equal(
          peer.commands.filter((q) => q === "DML EXECUTE").length,
          1,
        );
        if (mode === "commit") {
          assert.equal(peer.stats().commitACK, true);
          assert.equal(result.status, 200);
          assert.equal(result.data.committed, true);
          assert.equal(result.data.affectedRows, 1);
          assert.equal(peer.commands.includes("ROLLBACK"), false);
        } else {
          assert.equal(peer.stats().rollbackACK, true);
          assert.equal(result.status, 400);
          assert.match(result.data.error, /写入事务已回滚.*超过1000行/);
          assert.equal(peer.commands.includes("COMMIT"), false);
        }
        await owner.assertUnchanged();
      },
    );

for (const [mode, minimum, maximum, message] of [
  ["hold-commit", 2700, 5000, /提交结果未确认/],
  ["hold-dml", 5500, 8500, /未收到回滚确认/],
  ["hold-begin", 2700, 5000, /Query read timeout/],
])
  test(
    `PostgreSQL ${mode} retains existing query budgets and outcome with no replay`,
    { timeout: 12000 },
    async (t) => {
      const peer = await startPostgresWritePeer({ mode });
      t.after(() => peer.close());
      const clients = observe(t, peer.port),
        owner = await ownerHTTP(t),
        started = performance.now();
      const { response } = owner.send({ ...input, port: peer.port });
      await bounded(peer.reached, "held query");
      const result = await bounded(response, "query timeouts", maximum);
      const elapsed = performance.now() - started;
      assert(
        elapsed >= minimum && elapsed < maximum,
        `unchanged query timeout: ${elapsed} ms`,
      );
      assert.equal(result.status, 400);
      assert.match(result.data.error, message);
      assertClosed(clients);
      assert.equal(peer.commands.includes("ROLLBACK"), false);
      assert.equal(
        peer.commands.filter((q) => q === "COMMIT").length,
        mode === "hold-commit" ? 1 : 0,
      );
      assert.equal(
        peer.commands.filter((q) => q === "DML EXECUTE").length,
        mode === "hold-begin" ? 0 : 1,
      );
      await owner.assertUnchanged();
    },
  );

test(
  "PostgreSQL terminal cleanup is invocation-scoped and owner HTTP disconnect still does not cancel an explicit write",
  { timeout: 10000 },
  async (t) => {
    const held = await startPostgresWritePeer({ mode: "defer-dml" }),
      peer = await startPostgresWritePeer();
    t.after(() => held.close());
    t.after(() => peer.close());
    const heldClients = observe(t, held.port),
      clients = observe(t, peer.port),
      owner = await ownerHTTP(t);
    const first = owner.send({ ...input, port: held.port });
    await bounded(held.reached, "deferred DML");
    first.request.destroy();
    await assert.rejects(first.response);
    const second = await bounded(
      mutatePostgres({ ...input, port: peer.port }),
      "independent write",
    );
    assert.equal(second.committed, true);
    assertClosed(clients);
    assert.equal(heldClients.length, 1);
    assert.equal(heldClients[0].socket.destroyed, false);
    const closed = new Promise((resolve) =>
      heldClients[0].socket.once("close", resolve),
    );
    held.releaseDML();
    await bounded(closed, "disconnected owner's write completes");
    assertClosed(heldClients);
    assert.equal(held.stats().commitACK, true);
    assert.equal(held.commands.filter((q) => q === "DML EXECUTE").length, 1);
    assert.equal(held.commands.filter((q) => q === "COMMIT").length, 1);
    assert.equal(held.commands.includes("ROLLBACK"), false);
    await owner.assertUnchanged();
  },
);

test(
  "PostgreSQL write closes pinned SSH transport after ACK and releases existing SSH capacity",
  { timeout: 15000 },
  async (t) => {
    const peer = await startPostgresWritePeer({ ssl: true }),
      rollback = await startPostgresWritePeer({ ssl: true, mode: "rollback" }),
      ssh = await startSSHFixture({
        targets: [
          { host: "localhost", port: peer.port },
          { host: "localhost", port: rollback.port },
        ],
      });
    t.after(() => ssh.close());
    t.after(() => peer.close());
    t.after(() => rollback.close());
    const clients = observe(t, ssh.ssh.port),
      value = {
        ...input,
        host: "localhost",
        port: peer.port,
        ssl: true,
        ca: peer.cert,
        ssh: ssh.ssh,
      };
    const result = await bounded(mutatePostgres(value), "SSH write", 3000);
    assert.equal(result.committed, true);
    assertClosed(clients);
    await assert.rejects(
      bounded(
        mutatePostgres({ ...value, port: rollback.port }),
        "SSH rollback",
        3000,
      ),
      /写入事务已回滚.*超过1000行/,
    );
    assert.equal(rollback.stats().rollbackACK, true);
    assert.equal(rollback.commands.includes("COMMIT"), false);
    assertClosed(clients, 2);
    assert.deepEqual(ssh.stats.forwarded, [
      { host: "localhost", port: peer.port },
      { host: "localhost", port: rollback.port },
    ]);
    // These are the existing SSH helper's five slots, not a PostgreSQL write lease.
    const tunnels = [];
    try {
      for (let i = 0; i < 5; i++) tunnels.push(await openDatabaseSSH(value));
      await assert.rejects(openDatabaseSSH(value), /并发最多5/);
    } finally {
      for (const tunnel of tunnels) tunnel.close();
      await Promise.all(tunnels.map((tunnel) => tunnel.closed));
    }
    assertClosed(clients, 7);
  },
);

test(
  "PostgreSQL write rejects untrusted TLS and SSH identities before DML and closes actual transports",
  { timeout: 10000 },
  async (t) => {
    const peer = await startPostgresWritePeer({ ssl: true }),
      ssh = await startSSHFixture({
        targets: [{ host: "wrong.fixture", port: peer.port }],
      });
    t.after(() => ssh.close());
    t.after(() => peer.close());
    const direct = observe(t, peer.port),
      clients = observe(t, ssh.ssh.port);
    await assert.rejects(
      mutatePostgres({
        ...input,
        host: "localhost",
        port: peer.port,
        ssl: true,
      }),
      /certificate|self.signed/i,
    );
    assertClosed(direct);
    const value = {
      ...input,
      host: "wrong.fixture",
      port: peer.port,
      ssl: true,
      ca: peer.cert,
      ssh: ssh.ssh,
    };
    await assert.rejects(
      mutatePostgres({
        ...value,
        ssh: {
          ...ssh.ssh,
          hostKeySHA256:
            "SHA256:" + Buffer.alloc(32).toString("base64").replace(/=$/, ""),
        },
      }),
      /校验/,
    );
    assertClosed(clients);
    assert.equal(ssh.stats.authenticated, 0);
    assert.deepEqual(ssh.stats.forwarded, []);
    await assert.rejects(mutatePostgres(value), /hostname|altnames/i);
    assertClosed(clients, 2);
    assert.equal(ssh.stats.authenticated, 1);
    assert.deepEqual(peer.startups, []);
    assert.deepEqual(peer.commands, []);
  },
);

test("PostgreSQL constructor/connect errors close their public owned streams", async () => {
  let stream;
  class ConstructorFailure {
    constructor(options) {
      stream = options.stream;
      throw Error("constructor failure");
    }
  }
  await assert.rejects(
    mutatePostgres(input, { Client: ConstructorFailure }),
    /constructor failure/,
  );
  assert.equal(stream.closed, true);
  class ConnectFailure {
    constructor(options) {
      stream = options.stream;
    }
    async connect() {
      throw Error("connect failure");
    }
  }
  await assert.rejects(
    mutatePostgres(input, { Client: ConnectFailure }),
    /connect failure/,
  );
  assert.equal(stream.closed, true);
});

test(
  "PostgreSQL acknowledged write does not keep the process alive after transport cleanup",
  { timeout: 10000 },
  async () => {
    const child = spawn(
      process.execPath,
      ["tests/fixtures/postgres-write-exit-probe.mjs"],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      markerAt,
      timer;
    const result = new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (!markerAt && stdout.includes("PG_WRITE_RESOURCES_CLOSED")) {
          markerAt = performance.now();
          timer = setTimeout(() => child.kill(), 1000);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const safety = setTimeout(() => child.kill(), 8000);
    try {
      const { code, signal } = await result;
      assert.equal(code, 0, stdout + stderr + signal);
      assert(markerAt, stdout + stderr);
      assert(
        performance.now() - markerAt < 1000,
        "process exits naturally after actual close, not retained timeouts",
      );
    } finally {
      clearTimeout(timer);
      clearTimeout(safety);
    }
  },
);
