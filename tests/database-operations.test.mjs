import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { runPlan, snapshotPlan } from "../src/core.mjs";

test("ephemeral database grants are project-bound, readonly, redacted and revoked without persisting credentials", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "database-grants-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "fixture.db"),
    db = new DatabaseSync(filename);
  db.exec(
    "CREATE TABLE users(id INTEGER, name TEXT); INSERT INTO users VALUES(1,'Ada')",
  );
  db.close();
  const sessions = new DatabaseSessions();
  t.after(() => sessions.close());
  const connection = sessions.register("one", {
    name: "fixture",
    type: "sqlite",
    filename,
    password: "fixture-only-not-real",
  });
  assert.deepEqual(sessions.list("one"), [connection]);
  assert.deepEqual(sessions.list("two"), []);
  assert.equal(JSON.stringify(connection).includes(filename), false);
  const operation = {
    connectionId: connection.id,
    sql: "SELECT name FROM users WHERE id=?",
    parameters: [1],
  };
  assert.equal((await sessions.query("one", operation)).rows[0].name, "Ada");
  await assert.rejects(sessions.query("two", operation), /未授权|失效/);
  await assert.rejects(
    sessions.query("one", {
      ...operation,
      sql: "DELETE FROM users",
      parameters: [],
    }),
    /只读/,
  );
  assert.throws(() => sessions.revoke("two", connection.id));
  const pending = sessions.query("one", operation);
  sessions.revoke("one", connection.id);
  await assert.rejects(pending, /撤销/);
  await assert.rejects(sessions.query("one", operation), /失效/);
});

test("database operations feed pre-request parameters and post-request assertions only with an explicit resolver", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "database-operations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "fixture.db"),
    db = new DatabaseSync(filename);
  db.exec(
    "CREATE TABLE users(id INTEGER,name TEXT); INSERT INTO users VALUES(1,'Ada')",
  );
  db.close();
  const sessions = new DatabaseSessions(),
    connection = sessions.register("p", { name: "fixture", filename });
  t.after(() => sessions.close());
  const operation = {
    type: "database",
    connectionId: connection.id,
    sql: "SELECT name FROM users WHERE id=?",
    parameters: ["{{id}}"],
    name: "dbName",
    path: "$.rows[0].name",
  };
  const plan = snapshotPlan({
    steps: [
      {
        request: {
          url: "http://fixture.test/{{dbName}}",
          before: [operation],
          beforeScript:
            'apt.setRequestHeader("X-Database", apt.getVar("dbName"));',
          after: [{ ...operation, name: "afterName" }],
          afterScript:
            'pm.test("database matches response",()=>pm.expect(pm.response.json().name).to.equal(apt.getVar("afterName")));',
        },
      },
    ],
  });
  let requests = 0;
  const execute = async (request) => {
    requests++;
    assert.equal(request.url, "http://fixture.test/Ada");
    assert(
      request.headers.some(
        (row) => row.key === "X-Database" && row.value === "Ada",
      ),
    );
    return { status: 200, body: '{"name":"Ada"}', headers: {} };
  };
  const denied = await runPlan(plan, { id: 1 }, execute);
  assert.equal(denied.status, "failed");
  assert.match(denied.results[0].error, /未授权/);
  assert.equal(requests, 0);
  const run = await runPlan(plan, { id: 1 }, execute, {
    databaseQuery: (op, signal) => sessions.query("p", op, signal),
  });
  assert.equal(run.status, "passed", JSON.stringify(run.results));
  assert.equal(requests, 1);
  assert.equal(run.variables.dbName, "Ada");
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    sessions.query("p", operation, cancelled.signal),
    /取消/,
  );
  sessions.close();
  assert.deepEqual(sessions.list("p"), []);
});

test("HTTP database connection registration enforces token/origin and project execution uses only granted metadata", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "database-grants-http-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("one"),
    other = await app.store.create("two");
  const filename = path.join(root, "fixture.db"),
    db = new DatabaseSync(filename);
  db.exec(
    "CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES('from-db')",
  );
  db.close();
  const headers = {
    "content-type": "application/json",
    "x-local-token": app.token,
  };
  const url = app.url + "/api/projects/" + p.id + "/database-connections";
  const config = {
    name: "fixture",
    filename,
    password: "fixture-secret-not-real",
  };
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { ...headers, Origin: "https://untrusted.example" },
        body: JSON.stringify(config),
      })
    ).status,
    403,
  );
  const created = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(config),
  });
  assert.equal(created.ok, true);
  const connection = await created.json();
  assert.deepEqual(Object.keys(connection).sort(), ["id", "name", "type"]);
  assert.equal(
    JSON.stringify(await app.store.get(p.id)).includes(config.password),
    false,
  );
  const request = {
    name: "read",
    url: app.url + "/",
    before: [
      {
        type: "database",
        connectionId: connection.id,
        sql: "SELECT value FROM entries",
        parameters: [],
        name: "dbValue",
        path: "$.rows[0].value",
      },
    ],
    beforeScript: 'apt.setRequestHeader("X-From-DB",apt.getVar("dbValue"));',
  };
  const execute = (projectId) =>
    fetch(app.url + "/api/projects/" + projectId + "/execute", {
      method: "POST",
      headers,
      body: JSON.stringify({ request }),
    }).then((r) => r.json());
  const denied = await execute(other.id);
  assert.match(denied.error, /失效|未授权/);
  const result = await execute(p.id);
  assert.equal(result.extracted.dbValue, "from-db");
  assert.equal(result.outcome, "passed");
  assert.equal(
    (
      await fetch(url, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ id: connection.id }),
      })
    ).ok,
    true,
  );
  const revoked = await execute(p.id);
  assert.match(revoked.error, /失效/);
});
