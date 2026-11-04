import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  runPlan,
  snapshotPlan,
  normalizeRequest,
  restoreProject,
} from "../src/core.mjs";
import { Store, executeRequest } from "../src/runtime.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";
const script = (data) => ({ type: "customScript", enabled: 1, data });
const db = (connectionId, pattern = "$[0].value") => ({
  type: "database",
  enabled: 1,
  data: {
    connectionId,
    query: "SELECT value FROM records",
    isConsoleOutput: -1,
    variables: [{ name: "value", type: "environment", pattern }],
  },
});
test("native tasks execute through frozen plans after save/reload/restore without retaining grants", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const project = await store.create("fixture");
  const filename = path.join(root, "fixture.db"),
    database = new DatabaseSync(filename);
  database.exec(
    "CREATE TABLE records(value TEXT);INSERT INTO records VALUES('from-database')",
  );
  database.close();
  const sessions = new DatabaseSessions();
  t.after(() => sessions.close());
  const binding = sessions.register(project.id, {
    name: "fixture",
    filename,
    password: "not-a-real-secret",
  });
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    res.end(JSON.stringify({ value: req.headers["x-value"] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = normalizeRequest({
    url: `http://127.0.0.1:${server.address().port}/`,
    inheritSharedScripts: false,
    nativeTasks: {
      version: 1,
      before: [
        script('const prefix="before-";pm.environment.set("value","wrong");'),
        db(binding.id),
        script(
          'apt.setRequestHeader("x-value",prefix+pm.environment.get("value"));',
        ),
      ],
      after: [
        db(binding.id),
        script(
          'pm.test("after",()=>pm.expect(pm.response.json().value).to.equal("before-"+pm.environment.get("value")));',
        ),
      ],
    },
  });
  project.requests = [request];
  project.plans = [snapshotPlan({ steps: [{ request }] })];
  await store.save(project);
  const reloaded = await store.get(project.id);
  const restored = restoreProject(JSON.stringify(reloaded));
  await store.save(restored);
  assert.deepEqual(reloaded.requests[0].nativeTasks, request.nativeTasks);
  assert.deepEqual(
    restored.plans[0].steps[0].request.nativeTasks,
    request.nativeTasks,
  );
  assert.equal(JSON.stringify(reloaded).includes(filename), false);
  assert.equal(JSON.stringify(reloaded).includes("not-a-real-secret"), false);
  reloaded.requests[0].nativeTasks.before[0].data =
    'throw Error("live-request-mutated")';
  const granted = await runPlan(reloaded.plans[0], {}, executeRequest, {
    databaseQuery: (op, signal) => sessions.query(project.id, op, signal),
  });
  assert.equal(granted.status, "passed", JSON.stringify(granted.results));
  assert.equal(count, 1);
  assert.deepEqual(
    granted.results[0].databaseQueries.map((x) => x.phase),
    ["before", "after"],
  );
  const foreign = await runPlan(restored.plans[0], {}, executeRequest, {
    databaseQuery: (op, signal) => sessions.query(restored.id, op, signal),
  });
  assert.equal(foreign.status, "failed");
  assert.equal(count, 1);
  const missing = await runPlan(reloaded.plans[0], {}, executeRequest);
  assert.equal(missing.status, "failed");
  assert.match(missing.results[0].error, /未授权/);
  assert.equal(count, 1);
  sessions.close();
  const revoked = await runPlan(reloaded.plans[0], {}, executeRequest, {
    databaseQuery: (op, signal) => sessions.query(project.id, op, signal),
  });
  assert.equal(revoked.status, "failed");
  assert.equal(count, 1);
});
test("native task preflight rejects ambiguous legacy mixing and malformed later phases before any effect", async () => {
  const base = {
    url: "http://example.test",
    inheritSharedScripts: false,
    nativeTasks: {
      version: 1,
      before: [script('console.log("before")')],
      after: [],
    },
  };
  for (const patch of [
    { inheritSharedScripts: true },
    { beforeScript: "console.log(1)" },
    { before: [{ type: "set", name: "x", value: 1 }] },
    { sharedAfterScripts: [{ name: "x", code: "1" }] },
  ])
    assert.throws(() => normalizeRequest({ ...base, ...patch }), /混用/);
  const invalid = structuredClone(base);
  invalid.nativeTasks.after = [db("fixture", "$.constructor")];
  let sends = 0;
  await assert.rejects(
    runPlan({ steps: [{ request: invalid }] }, {}, () => {
      sends++;
    }),
    /禁止/,
  );
  assert.equal(sends, 0);
});

test("scripts cannot rewrite frozen native tasks before later execution", async () => {
  let sends = 0,
    queries = 0;
  const request = normalizeRequest({
    url: "http://example.test",
    inheritSharedScripts: false,
    nativeTasks: {
      version: 1,
      before: [script('request.nativeTasks.after[0].data.query="SELECT 99";')],
      after: [db("fixture")],
    },
  });
  const result = await runPlan(
    snapshotPlan({ steps: [{ request }] }),
    {},
    async () => {
      sends++;
      return { status: 200, headers: {}, body: "{}" };
    },
    {
      databaseQuery: async () => {
        queries++;
        return { rows: [{ value: "x" }] };
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.match(result.results[0].error, /冻结/);
  assert.equal(sends, 0);
  assert.equal(queries, 0);
});
