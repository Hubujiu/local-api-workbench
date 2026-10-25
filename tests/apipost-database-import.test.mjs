import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import { nativeDatabaseFixture } from "./fixtures/apipost-database.mjs";
import {
  importIntoProject,
  runPlan,
  snapshotPlan,
  restoreProject,
} from "../src/core.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";
const project = () => ({
  requests: [],
  folders: [],
  environments: [],
  servers: [],
  globalVariables: {},
  settings: {},
});
test("native PostgreSQL definition imports without connection configuration; explicit ephemeral rebinding completes HTTP and roundtrip", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root),
    p = await store.create("target");
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    res.end(JSON.stringify({ value: req.headers["x-db-value"] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const doc = nativeDatabaseFixture(
      `http://127.0.0.1:${server.address().port}/`,
    ),
    source = JSON.stringify(doc);
  importIntoProject(p, doc);
  assert.equal(JSON.stringify(doc), source);
  const bindingId = p.settings.apipostDatabases[0].id;
  assert.equal(
    p.requests[0].nativeTasks.before[1].data.connectionId,
    bindingId,
  );
  for (const secret of [
    "discard-this-fictional-password",
    "private-host.invalid",
    "synthetic-user",
    "synthetic-db",
  ])
    assert.equal(JSON.stringify(p).includes(secret), false);
  p.plans = [snapshotPlan({ steps: [{ request: p.requests[0] }] })];
  await store.save(p);
  const loaded = await store.get(p.id),
    restored = restoreProject(JSON.stringify(loaded));
  await store.save(restored);
  assert.deepEqual(
    restored.requests[0].nativeTasks,
    loaded.requests[0].nativeTasks,
  );
  const denied = await runPlan(loaded.plans[0], {}, executeRequest);
  assert.equal(denied.status, "failed");
  assert.equal(count, 0);
  // SQLite exercises the generic alias mechanism locally; real PostgreSQL is a separate integration fixture.
  const filename = path.join(root, "fixture.db");
  new DatabaseSync(filename).close();
  const sessions = new DatabaseSessions();
  t.after(() => sessions.close());
  const grant = sessions.register(p.id, {
    name: "explicit test",
    filename,
    bindingId,
  });
  assert.throws(
    () => sessions.register(p.id, { name: "duplicate", filename, bindingId }),
    /已授权/,
  );
  const result = await runPlan(loaded.plans[0], {}, executeRequest, {
    databaseQuery: (op, signal) => sessions.query(p.id, op, signal),
  });
  assert.equal(result.status, "passed", JSON.stringify(result.results));
  assert.equal(count, 1);
  const foreign = await runPlan(restored.plans[0], {}, executeRequest, {
    databaseQuery: (op, signal) => sessions.query(restored.id, op, signal),
  });
  assert.equal(foreign.status, "failed");
  assert.equal(count, 1);
  const pending = sessions.query(p.id, {
    connectionId: bindingId,
    sql: "SELECT 1 AS value",
    parameters: [],
  });
  sessions.revoke(p.id, grant.id);
  await assert.rejects(pending, /撤销/);
  const revoked = await runPlan(loaded.plans[0], {}, executeRequest, {
    databaseQuery: (op, signal) => sessions.query(p.id, op, signal),
  });
  assert.equal(revoked.status, "failed");
  assert.equal(count, 1);
});
test("native database import failures are atomic and unknown/unsafe configuration is not silently dropped", () => {
  for (const change of [
    (d) => (d.global.db_link[0].type = "oracle"),
    (d) => (d.global.db_link[0].project_id = "other"),
    (d) => d.global.db_link.push(structuredClone(d.global.db_link[0])),
    (d) => (d.global.db_link[0].config.default.ssh.enable = 1),
    (d) => (d.global.db_link[0].config["1"].use_default = -1),
    (d) => (d.global.db_link[0].config.default.db_config.unknown = true),
    (d) => (d.apis[1].request.pre_tasks[1].data.connectionId = "missing"),
    (d) => (d.apis[1].request.pre_tasks[1].data.query = "SELECT {{unsafe}}"),
    (d) => (d.apis[1].request.pre_tasks[1].data.variables[0].type = "unknown"),
    (d) =>
      (d.apis[1].request.pre_tasks[1].origin = {
        scope: "project",
        id: "spoof",
      }),
  ]) {
    const doc = nativeDatabaseFixture(),
      p = project(),
      before = structuredClone(p);
    change(doc);
    assert.throws(() => importIntoProject(p, doc));
    assert.deepEqual(p, before);
  }
});
test("native mixed tasks retain inherited script order and stable rebinding identity without double translation", () => {
  const doc = nativeDatabaseFixture();
  doc.global.global_param.pre_tasks = [
    {
      type: "customScript",
      enabled: 1,
      id: "global",
      name: "Global",
      data: "const globalValue=1;",
    },
  ];
  const p = project();
  importIntoProject(p, doc);
  assert.deepEqual(
    p.requests[0].nativeTasks.before.map((t) => t.id),
    ["global", "before", "query", "after-db"],
  );
  assert.equal(
    p.requests[0].nativeTasks.before[2].data.connectionId,
    p.settings.apipostDatabases[0].id,
  );
  assert.equal(p.requests[0].nativeTasks.before[0].origin.scope, "project");
});
test("native result scope names map explicitly and survive inherited task flattening", () => {
  const doc = nativeDatabaseFixture();
  doc.global.global_param.pre_tasks = [
    {
      type: "customScript",
      enabled: 1,
      id: "global-script",
      name: "Global",
      data: "const marker=1;",
    },
  ];
  doc.apis[1].request.pre_tasks[1].data.variables = [
    "environment",
    "variables",
    "globals",
  ].map((type, i) => ({ type, name: "value" + i, pattern: "$[0].value" }));
  const p = project();
  importIntoProject(p, doc);
  assert.deepEqual(
    p.requests[0].nativeTasks.before[2].data.variables.map((x) => x.type),
    ["environment", "temporary", "global"],
  );
  for (const type of ["temporary", "global", "__proto__", "constructor"]) {
    const invalid = nativeDatabaseFixture();
    invalid.apis[1].request.pre_tasks[1].data.variables[0].type = type;
    assert.throws(() => importIntoProject(project(), invalid), /作用域/);
  }
});

test("native MySQL catalog strips credentials and retains scoped engine identity", () => {
  const doc = nativeDatabaseFixture("http://127.0.0.1:1/", "mysql"),
    p = project(),
    before = JSON.stringify(doc);
  importIntoProject(p, doc);
  assert.equal(p.settings.apipostDatabases[0].type, "mysql");
  assert.equal(
    p.requests[0].nativeTasks.before[1].data.connectionId,
    p.settings.apipostDatabases[0].id,
  );
  assert(!JSON.stringify(p).includes("discard-this-fictional-password"));
  assert(
    !JSON.stringify(p.settings.apipostDatabases).includes(
      "private-host.invalid",
    ),
  );
  assert.equal(JSON.stringify(doc), before);
  const saved = JSON.stringify(p);
  const invalid = structuredClone(doc);
  invalid.global.db_link[0].config.default.db_config.auth_source = "admin";
  assert.throws(() => importIntoProject(p, invalid), /auth_source/);
  assert.equal(JSON.stringify(p), saved);
});

test("native MySQL resultset wrapper survives inheritance and cannot be injected by source", () => {
  const doc = nativeDatabaseFixture("http://127.0.0.1:1/", "mysql"),
    p = project();
  importIntoProject(p, doc);
  assert.equal(
    p.requests[0].nativeTasks.before[1].data.resultShape,
    "mysql-resultsets",
  );
  assert.equal(
    p.requests[0].nativeTasks.before[1].data.variables[0].pattern,
    "$[0][0].value",
  );
  const bad = structuredClone(doc);
  bad.apis[1].request.pre_tasks[1].data.resultShape = "mysql-resultsets";
  assert.throws(() => importIntoProject(project(), bad));
});
