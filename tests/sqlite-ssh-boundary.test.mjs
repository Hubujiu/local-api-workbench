import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createApp } from "../src/server.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sqlite-ssh-boundary-"));
  const filename = path.join(root, "fixture.sqlite"),
    db = new DatabaseSync(filename);
  db.exec("CREATE TABLE audit(value TEXT NOT NULL)");
  db.close();
  const sockets = new Set();
  let sshConnections = 0;
  const ssh = net.createServer((s) => {
    sshConnections++;
    sockets.add(s);
    s.on("error", () => {});
    s.on("close", () => sockets.delete(s));
    s.destroy();
  });
  await new Promise((r) => ssh.listen(0, "127.0.0.1", r));
  let app;
  const original = childProcess.fork;
  let forks = 0;
  // Observe actual native-process dispatch; do not stub database/file operations.
  childProcess.fork = function (modulePath, ...args) {
    if (String(modulePath).endsWith("/database-process-entry.mjs")) forks++;
    return Reflect.apply(original, this, [modulePath, ...args]);
  };
  syncBuiltinESMExports();
  t.after(async () => {
    childProcess.fork = original;
    syncBuiltinESMExports();
    if (app) {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
    }
    for (const s of sockets) s.destroy();
    await new Promise((r) => ssh.close(r));
    await rm(root, { recursive: true, force: true });
  });
  app = await createApp({ root: path.join(root, "app"), port: 0 });
  const project = await app.store.create("Synthetic SQLite dispatch");
  const send = async (body, token = app.token) => {
    const response = await fetch(
      app.url + "/api/projects/" + project.id + "/database",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-local-token": token },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  const count = () => {
    const c = new DatabaseSync(filename, { readOnly: true });
    try {
      return c.prepare("SELECT COUNT(*) AS n FROM audit").get().n;
    } finally {
      c.close();
    }
  };
  return {
    root,
    filename,
    send,
    count,
    forks: () => forks,
    sshConnections: () => sshConnections,
    ssh: {
      host: "127.0.0.1",
      port: ssh.address().port,
      username: "fictional-user",
      password: "fictional-ssh-secret",
      hostKeySHA256: "SHA256:" + "A".repeat(43),
    },
  };
}
const variants = [
  ["configured", (f) => f.ssh],
  ["empty-object", () => ({})],
  ["empty-string", () => ""],
  ["null", () => null],
  ["false", () => false],
];
for (const [label, ssh] of variants) {
  test(
    `owner SQLite ${label} SSH rejects reads and writes before native dispatch or file changes`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t),
        before = await readFile(f.filename);
      for (const type of ["sqlite", undefined])
        for (const writing of [true, false]) {
          const result = await f.send({
            type,
            filename: f.filename,
            ssh: ssh(f),
            allowWrite: writing,
            sql: writing
              ? "INSERT INTO audit(value) VALUES(?)"
              : "SELECT value FROM audit",
            parameters: writing ? ["fixture-value"] : [],
          });
          assert.equal(
            f.count(),
            0,
            "unsupported SSH must not mutate the actual local SQLite file",
          );
          assert.equal(
            f.forks(),
            0,
            "reject before dispatching any SQLite read/write process",
          );
          assert.deepEqual(await readFile(f.filename), before);
          assert.equal(result.status, 400);
          assert.match(result.body.error, /SQLite.*SSH/);
          assert.doesNotMatch(
            JSON.stringify(result.body),
            /fictional-ssh-secret/,
          );
          assert.equal(f.sshConnections(), 0);
        }
      const missing = path.join(f.root, "must-not-exist.sqlite");
      const result = await f.send({
        type: "sqlite",
        filename: missing,
        ssh: ssh(f),
        allowWrite: true,
        sql: "INSERT INTO audit(value) VALUES(?)",
        parameters: ["fixture"],
      });
      assert.equal(result.status, 400);
      assert.match(result.body.error, /SQLite.*SSH/);
      assert.equal(f.forks(), 0);
      await assert.rejects(stat(missing), { code: "ENOENT" });
    },
  );
}
test(
  "default SQLite aliases reject supplied SSH without treating unknown providers as SQLite",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    for (const type of ["", null, false, 0]) {
      const result = await f.send({
        type,
        filename: f.filename,
        ssh: null,
        sql: "SELECT value FROM audit",
      });
      assert.equal(result.status, 400);
      assert.match(result.body.error, /SQLite.*SSH/);
    }
    for (const allowWrite of [true, false]) {
      const result = await f.send({
        type: "unknown-provider",
        filename: f.filename,
        ssh: f.ssh,
        allowWrite,
        sql: "SELECT 1",
      });
      assert.equal(result.status, 400);
      assert.doesNotMatch(result.body.error, /SQLite暂不支持SSH/);
    }
    assert.equal(f.count(), 0);
    assert.equal(f.forks(), 0);
    assert.equal(f.sshConnections(), 0);
  },
);
test(
  "ordinary owner SQLite read/write keeps per-request authorization and no-SSH behavior",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      write = {
        type: "sqlite",
        filename: f.filename,
        allowWrite: true,
        sql: "INSERT INTO audit(value) VALUES(?)",
        parameters: ["fixture-value"],
      };
    assert.equal(
      (await f.send({ ...write, ssh: f.ssh }, "wrong-owner")).status,
      403,
    );
    assert.equal(f.forks(), 0);
    assert.equal((await f.send({ ...write, allowWrite: false })).status, 400);
    assert.equal(f.count(), 0);
    const result = await f.send(write);
    assert.equal(result.status, 200);
    assert.equal(result.body.committed, true);
    assert.equal(f.count(), 1);
    const read = await f.send({
      filename: f.filename,
      sql: "SELECT value FROM audit",
    });
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.rows, [{ value: "fixture-value" }]);
    assert.equal((await f.send({ ...write, allowWrite: false })).status, 400);
    assert.equal(f.count(), 1);
    assert.equal(f.sshConnections(), 0);
  },
);
