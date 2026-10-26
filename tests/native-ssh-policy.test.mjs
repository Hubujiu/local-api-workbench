import test from "node:test";
import assert from "node:assert/strict";
import {
  DatabaseSessions,
  assertDatabaseBindingRequirements,
} from "../src/database-sessions.mjs";
import { importIntoProject, restoreProject } from "../src/core.mjs";
import { nativeDatabaseFixture } from "./fixtures/apipost-database.mjs";
const sourceFixture = () => {
  const s = nativeDatabaseFixture("http://127.0.0.1:1/");
  Object.assign(s.global.db_link[0].config.default.ssh, {
    enable: 1,
    password: "source-ssh-password",
    private_key: "/do/not/read/source-key",
    host: "source-ssh-host.invalid",
  });
  return s;
};
test("active native SSH imports only an effective default requirement, not secrets or file paths", () => {
  const source = sourceFixture(),
    before = structuredClone(source),
    p = { version: 1, requests: [], environments: [], settings: {} };
  importIntoProject(p, source);
  assert.equal(p.settings.apipostDatabases[0].requiresSSH, true);
  for (const secret of [
    "source-ssh-password",
    "/do/not/read/source-key",
    "source-ssh-host.invalid",
    "discard-this-fictional-password",
  ])
    assert(!JSON.stringify(p).includes(secret));
  assert.equal(
    restoreProject(p).settings.apipostDatabases[0].requiresSSH,
    true,
  );
  assert.deepEqual(source, before);
  const disabled = sourceFixture();
  disabled.global.db_link[0].config.default.ssh.enable = -1;
  disabled.global.db_link[0].config[1].ssh.enable = 1;
  const other = { requests: [], environments: [], settings: {} };
  importIntoProject(other, disabled);
  assert.equal(
    other.settings.apipostDatabases[0].requiresSSH,
    undefined,
    "inherited environment uses default requirement, not stale child settings",
  );
});
test("missing SSH and incompatible source policies reject without treating the marker as authorization", () => {
  assert.throws(
    () =>
      assertDatabaseBindingRequirements(
        { type: "postgres", requiresSSH: true },
        { type: "postgres" },
      ),
    /SSH/,
  );
  assert.throws(
    () =>
      assertDatabaseBindingRequirements(
        { type: "mysql" },
        { type: "postgres" },
      ),
    /类型/,
  );
  assert.throws(
    () =>
      assertDatabaseBindingRequirements(
        { type: "postgres", requiresSSH: false },
        { type: "postgres" },
      ),
    /来源/,
  );
  const sessions = new DatabaseSessions();
  assert.throws(
    () =>
      sessions.register("p", {
        name: "bad",
        type: "postgres",
        ssh: { host: "127.0.0.1", username: "fixture", password: "fixture" },
      }),
    /指纹/,
  );
  sessions.close();
});
test("current catalog changes reject old direct grants by imported ID and by session UUID before connecting", async () => {
  const bindingId = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20);
  let source = { id: bindingId, type: "postgres" };
  const sessions = new DatabaseSessions({
    resolveProject: async (id) => ({
      id,
      settings: { apipostDatabases: source ? [source] : [] },
    }),
  });
  const grant = sessions.register("p", {
    type: "postgres",
    name: "old direct",
    host: "127.0.0.1",
    port: 1,
    bindingId,
  });
  source = { ...source, requiresSSH: true };
  for (const connectionId of [bindingId, grant.id])
    await assert.rejects(
      sessions.query("p", { connectionId, sql: "SELECT 1" }),
      /要求SSH/,
    );
  source = { id: bindingId, type: "mysql" };
  await assert.rejects(
    sessions.query("p", { connectionId: grant.id, sql: "SELECT 1" }),
    /类型/,
  );
  source = null;
  await assert.rejects(
    sessions.query("p", { connectionId: grant.id, sql: "SELECT 1" }),
    /已移除/,
  );
  sessions.close();
});
test("revocation while current source is loading cannot start a database query", async () => {
  const bindingId = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20);
  let release;
  const waiting = new Promise((r) => (release = r));
  const sessions = new DatabaseSessions({
    resolveProject: async (id) => {
      await waiting;
      return {
        id,
        settings: { apipostDatabases: [{ id: bindingId, type: "postgres" }] },
      };
    },
  });
  const grant = sessions.register("p", {
    type: "postgres",
    name: "revoked",
    host: "127.0.0.1",
    port: 1,
    bindingId,
  });
  const query = sessions.query("p", {
    connectionId: grant.id,
    sql: "SELECT 1",
  });
  sessions.revoke("p", grant.id);
  release();
  await assert.rejects(query, /撤销/);
  sessions.close();
});
test("HTTP uses the current source requirement even when a task references the old session UUID", async (t) => {
  const { createApp } = await import("../src/server.mjs"),
    { mkdtemp, rm } = await import("node:fs/promises"),
    os = await import("node:os"),
    path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "ssh-policy-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("Policy");
  importIntoProject(p, nativeDatabaseFixture("http://127.0.0.1:1/"));
  await app.store.save(p);
  const headers = {
    "x-local-token": app.token,
    "content-type": "application/json",
  };
  const config = {
    name: "old grant",
    type: "postgres",
    host: "127.0.0.1",
    port: 1,
    bindingId: p.settings.apipostDatabases[0].id,
  };
  const registered = await fetch(
    app.url + "/api/projects/" + p.id + "/database-connections",
    { method: "POST", headers, body: JSON.stringify(config) },
  );
  assert.equal(registered.status, 200);
  const grant = await registered.json();
  p.settings.apipostDatabases[0].requiresSSH = true;
  await app.store.save(p);
  for (const connectionId of [config.bindingId, grant.id]) {
    const request = structuredClone(p.requests[0]);
    request.nativeTasks.before.find(
      (t) => t.type === "database",
    ).data.connectionId = connectionId;
    const response = await fetch(
      app.url + "/api/projects/" + p.id + "/execute",
      { method: "POST", headers, body: JSON.stringify({ request }) },
    );
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.outcome, "failed");
    assert.match(result.error, /SSH/);
  }
  const again = await fetch(
    app.url + "/api/projects/" + p.id + "/database-connections",
    { method: "POST", headers, body: JSON.stringify(config) },
  );
  assert.equal(again.status, 400);
  assert.match((await again.json()).error, /SSH/);
});
test("completed query results are discarded if the source policy changes during execution", async (t) => {
  const { DatabaseSync } = await import("node:sqlite"),
    { mkdtemp, rm } = await import("node:fs/promises"),
    os = await import("node:os"),
    path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "source-query-")),
    filename = path.join(root, "fixture.db");
  const db = new DatabaseSync(filename);
  db.exec(
    "CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('must-not-apply')",
  );
  db.close();
  t.after(() => rm(root, { recursive: true, force: true }));
  const bindingId = "apipost-" + "a".repeat(20) + "-db-" + "b".repeat(20);
  let reads = 0;
  // SQLite is an independent transport fixture for the generic session gate;
  // it is not claimed to be an original imported SSH database engine.
  const sessions = new DatabaseSessions({
    resolveProject: async (id) => ({
      id,
      settings: {
        apipostDatabases: [
          { id: bindingId, type: ++reads === 1 ? "sqlite" : "postgres" },
        ],
      },
    }),
  });
  const grant = sessions.register("p", {
    name: "result gate",
    type: "sqlite",
    filename,
    bindingId,
  });
  await assert.rejects(
    sessions.query("p", {
      connectionId: grant.id,
      sql: "SELECT value FROM fixture",
    }),
    /类型已变化/,
  );
  assert.equal(reads, 2);
  sessions.close();
});
