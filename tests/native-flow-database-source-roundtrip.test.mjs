import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import {
  normalizeRequest,
  snapshotPlan,
  importIntoProject,
} from "../src/core.mjs";
import { verifyFrozenTaskSource } from "../src/apipost-flow-task-source-export.mjs";
import { exportApipostDirectory } from "../src/apipost-directory-export.mjs";

const task = (id, type, data, enabled = 1) => ({
  id,
  name: id,
  type,
  data,
  enabled,
});
const dbId = (type) =>
  "apipost-" +
  "a".repeat(20) +
  "-db-" +
  (type === "mysql" ? "b" : "c").repeat(20);
const source = () => ({
  version: 1,
  before: [
    ...["postgres", "mysql"].map((type) =>
      task(type, "database", {
        connectionId: dbId(type),
        query: "SELECT 1 AS value",
        isConsoleOutput: -1,
        variables: [
          {
            name: "dbMustNotExist",
            type: "environment",
            pattern: type === "mysql" ? "$[0][0].value" : "$[0].value",
          },
        ],
        ...(type === "mysql" ? { resultShape: "mysql-resultsets" } : {}),
      }),
    ),
    task(
      "source-script",
      "customScript",
      'throw Error("INERT BEFORE MUST NOT EXECUTE")',
    ),
    task("source-wait", "wait", 1000),
    task("source-disabled-wait", "wait", "{{unresolved}}", -1),
  ],
  after: [
    task(
      "source-script",
      "customScript",
      'throw Error("INERT AFTER MUST NOT EXECUTE")',
    ),
    task("source-pick", "pickVars", {
      source: "responseJson",
      variables: [
        { name: "forbidden", expression: "$.value", type: "envVars" },
      ],
    }),
    task("source-assert", "assert", {
      type: "responseCode",
      expression: { path: "", compareType: "eq", compareValue: "599" },
    }),
  ],
});
function fixture(url) {
  const request = normalizeRequest({
    id: "api",
    name: "Frozen",
    url,
    method: "GET",
    inheritSharedScripts: false,
    scriptDialect: "apipost8",
    beforeScript: 'apt.setRequestHeader("x-step","explicit");',
    afterScript: 'apt.environment.set("stepResult",apt.response.json().value);',
    importedNativeTaskSource: source(),
  });
  return {
    id: "project",
    name: "Source round trip",
    settings: {
      apipostDatabases: ["postgres", "mysql"].map((type) => ({
        id: dbId(type),
        name: type,
        type,
        sourceProjectId: "synthetic",
        sourceId: type,
      })),
    },
    environments: [{ id: "env", name: "E", variables: {} }],
    requests: [],
    plans: [
      snapshotPlan({
        id: "plan",
        name: "Frozen plan",
        environmentId: "env",
        statusPolicy: "strict200",
        steps: [{ id: "step", request }],
      }),
    ],
  };
}

test("frozen credential-free database provenance stays inert across directory generations, owner export, restore and restart", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, step: req.headers["x-step"] });
    res.setHeader("content-type", "application/json");
    res.end('{"value":"step-only"}');
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "native-flow-source-"));
  let app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const input = fixture(
    "http://127.0.0.1:" + upstream.address().port + "/step",
  );
  const before = structuredClone(input);
  assert.throws(() => exportApipostDirectory(input), /rebind/);
  const document = exportApipostDirectory(input, { databaseMode: "rebind" });
  assert.deepEqual(input, before);
  assert.equal(seen.length, 0);
  const records = JSON.parse(
    document.files.find((f) => f.path === "settings/db_links.json").text,
  );
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.config.default.db_config.host, "");
    assert.equal(record.config.default.db_config.password, "");
  }
  const p = await app.store.create("Imported");
  importIntoProject(p, document);
  assert.deepEqual(p.requests, []);
  await app.store.save(p);
  const url =
    app.url +
    "/api/projects/" +
    p.id +
    "/export?format=apipost-directory&databaseMode=rebind";
  assert.equal((await fetch(url)).status, 403);
  const response = await fetch(url, {
    headers: { "x-local-token": app.token },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const q = await app.store.create("Again");
  importIntoProject(q, await response.json());
  assert.deepEqual(q.requests, []);
  await app.store.save(q);
  const restored = await app.store.restore(q);
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
  app = await createApp({ root, port: 0 });
  assert.equal(seen.length, 0);
  for (const current of [p, q, restored]) {
    const loaded = await app.store.get(current.id);
    const request = loaded.plans[0].steps[0].request;
    assert.deepEqual(canonicalSource(loaded), source());
    assert.equal(request.nativeTasks, undefined);
    assert.equal(request.importedScriptTasks, undefined);
    const result = await fetch(
      app.url + "/api/projects/" + current.id + "/run",
      {
        method: "POST",
        headers: {
          "x-local-token": app.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ planId: loaded.plans[0].id }),
      },
    );
    const run = await result.json();
    assert.equal(result.status, 200, JSON.stringify(run));
    assert.equal(run.status, "passed", JSON.stringify(run));
    const saved = await app.store.get(current.id);
    const env = saved.environments.find(
      (e) => e.id === loaded.plans[0].environmentId,
    );
    assert.equal(env.variables.stepResult, "step-only");
    assert.equal(env.variables.forbidden, undefined);
    assert.equal(env.variables.dbMustNotExist, undefined);
    assert.deepEqual(canonicalSource(saved), source());
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 3 }, () => ({ url: "/step", step: "explicit" })),
  );
});

function canonicalSource(project) {
  const result = structuredClone(
    project.plans[0].steps[0].request.importedNativeTaskSource,
  );
  for (const task of [...result.before, ...result.after])
    if (task.type === "database")
      task.data.connectionId = dbId(
        project.settings.apipostDatabases.find(
          (db) => db.id === task.data.connectionId,
        )?.type,
      );
  return result;
}

test("database source refuses ambiguous bindings, credentials and unsupported shapes atomically", () => {
  for (const mutate of [
    (p) => {
      p.settings.apipostDatabases = [];
    },
    (p) => {
      p.settings.apipostDatabases[0].password = "never-export";
    },
    (p) => {
      p.settings.apipostDatabases[0].requiresSSH = true;
    },
    (p) => {
      p.plans[0].steps[0].request.importedNativeTaskSource.before[0].data.connectionId =
        "missing";
    },
    (p) => {
      p.plans[0].steps[0].request.importedNativeTaskSource.before[1].data.resultShape =
        "redis-value";
    },
    (p) => {
      p.plans[0].steps[0].request.importedNativeTaskSource.before[0].origin = {
        scope: "project",
        id: "p",
      };
    },
    (p) => {
      p.plans[0].steps[0].request.importedNativeTaskSource.before[0].data.writeIntent = true;
    },
  ]) {
    const p = fixture("http://127.0.0.1:1/never");
    mutate(p);
    const original = structuredClone(p);
    assert.throws(() => exportApipostDirectory(p, { databaseMode: "rebind" }));
    assert.deepEqual(p, original);
  }
});

test("database provenance readback requires exact mapped references and all source semantics", () => {
  const original = source();
  const mapped = structuredClone(original);
  const ids = new Map([
    [dbId("postgres"), "new-pg"],
    [dbId("mysql"), "new-mysql"],
  ]);
  for (const task of mapped.before.filter((t) => t.type === "database"))
    task.data.connectionId = ids.get(task.data.connectionId);
  verifyFrozenTaskSource(original, mapped, ids);
  assert.throws(() => verifyFrozenTaskSource(original, mapped), /引用缺失/);
  for (const mutate of [
    (s) => {
      s.before[0].data.connectionId = "new-mysql";
    },
    (s) => {
      s.before[0].data.query = "SELECT 2";
    },
    (s) => {
      s.before[0].data.variables[0].type = "temporary";
    },
    (s) => {
      s.before[1].data.resultShape = "redis-value";
    },
    (s) => {
      s.before[0].enabled = -1;
    },
  ]) {
    const altered = structuredClone(mapped);
    mutate(altered);
    assert.throws(
      () => verifyFrozenTaskSource(original, altered, ids),
      /不一致/,
    );
  }
});
