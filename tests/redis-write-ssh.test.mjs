import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { mutateRedis, queryRedis, parseRESP } from "../src/redis.mjs";
import { createApp } from "../src/server.mjs";

async function peer(t) {
  const commands = [],
    sockets = new Set();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const frame = parseRESP(buffer);
      if (!frame) return;
      assert.equal(frame.bytes, buffer.length);
      buffer = Buffer.alloc(0);
      commands.push(frame.value.map((v) => v.toString()));
      socket.write("+OK\r\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  });
  return {
    port: server.address().port,
    commands,
    connections: () => connections,
  };
}
const variants = [
  [
    "configured",
    (p) => ({
      host: "127.0.0.1",
      port: p,
      username: "fictional-ssh-user",
      password: "fictional-ssh-secret",
      hostKeySHA256: "SHA256:" + "A".repeat(43),
    }),
  ],
  ["empty-object", () => ({})],
  ["empty-string", () => ""],
  ["null", () => null],
  ["false", () => false],
];
const input = (p) => ({
  type: "redis",
  allowWrite: true,
  host: "127.0.0.1",
  port: p,
  database: "2",
  password: "fictional-db-secret",
  command: ["SET", "fictional-key", "fixture-value"],
});
for (const [label, ssh] of variants) {
  test(`manual Redis ${label} SSH is rejected before either transport receives credentials or commands`, async (t) => {
    const direct = await peer(t),
      tunnel = await peer(t);
    await assert.rejects(
      mutateRedis({ ...input(direct.port), ssh: ssh(tunnel.port) }),
      (error) => {
        assert.match(error.message, /SSH/);
        assert.doesNotMatch(
          error.message,
          /fictional-ssh-secret|fictional-db-secret/,
        );
        return true;
      },
    );
    assert.equal(direct.connections(), 0);
    assert.equal(tunnel.connections(), 0);
    assert.deepEqual(direct.commands, []);
    assert.deepEqual(tunnel.commands, []);
  });
}
for (const [label, ssh] of variants) {
  test(`direct Redis read ${label} SSH is rejected without direct fallback`, async (t) => {
    const direct = await peer(t),
      tunnel = await peer(t);
    await assert.rejects(
      queryRedis({
        ...input(direct.port),
        allowWrite: false,
        command: ["GET", "fictional-key"],
        ssh: ssh(tunnel.port),
      }),
      /SSH/,
    );
    assert.equal(direct.connections(), 0);
    assert.equal(tunnel.connections(), 0);
    assert.deepEqual(direct.commands, []);
  });
}
test(
  "owner HTTP rejects unsupported Redis SSH without granting later writes or persisting credentials",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "redis-ssh-owner-"));
    const app = await createApp({ root, port: 0 });
    t.after(async () => {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const project = await app.store.create("Fictional transport boundary"),
      before = await app.store.get(project.id);
    const direct = await peer(t),
      tunnel = await peer(t);
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
    for (const [, ssh] of variants) {
      const response = await send({
        ...input(direct.port),
        ssh: ssh(tunnel.port),
      });
      assert.equal(response.status, 400);
      assert.match(response.value.error, /SSH/);
      assert.doesNotMatch(
        JSON.stringify(response.value),
        /fictional-db-secret|fictional-ssh-secret/,
      );
      assert.equal(direct.connections(), 0);
      assert.equal(tunnel.connections(), 0);
    }
    const denied = await send(input(direct.port), "not-the-owner");
    assert.equal(denied.status, 403);
    const noGrant = await send({ ...input(direct.port), allowWrite: false });
    assert.equal(noGrant.status, 400);
    assert.equal(direct.connections(), 0);
    assert.equal(tunnel.connections(), 0);
    const allowed = await send(input(direct.port));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.value.applied, true);
    assert.deepEqual(
      direct.commands.map((c) => c[0]),
      ["AUTH", "SELECT", "SET"],
    );
    assert.equal(tunnel.connections(), 0);
    const after = await send({ ...input(direct.port), allowWrite: false });
    assert.equal(after.status, 400);
    assert.equal(direct.connections(), 1);
    assert.deepEqual(await app.store.get(project.id), before);
  },
);
