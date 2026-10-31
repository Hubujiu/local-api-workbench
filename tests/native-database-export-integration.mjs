import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import { Store } from "../src/runtime.mjs";
import { nativeDatabaseFixture } from "./fixtures/apipost-database.mjs";

// Invoked only by remote-database.mjs with its explicitly supplied disposable
// PostgreSQL/MySQL service configuration. This is a real transport test, not a
// substitute database, a native application run, or a durable connection grant.
const close = (server) =>
  new Promise((resolve) => {
    if (!server) return resolve();
    server.close(resolve);
    server.closeAllConnections?.();
  });
const binding = (project) => project.settings.apipostDatabases[0];
const request = (project) => project.requests[0];
function semanticPipeline(project) {
  const result = structuredClone(request(project).nativeTasks);
  for (const phase of ["before", "after"])
    for (const task of result[phase]) {
      delete task.id; // Native directory export intentionally regenerates IDs.
      if (task.type === "database") {
        const source = project.settings.apipostDatabases.find(
          (entry) => entry.id === task.data.connectionId,
        );
        assert(
          source,
          "every executable task remains bound to an exported connection",
        );
        task.data.connectionId = source.type + ":" + source.name;
      }
    }
  return result;
}
function assertNoSecrets(value, config) {
  const text = JSON.stringify(value);
  for (const secret of [
    "discard-this-fictional-password",
    "private-host.invalid",
    "synthetic-user",
    "synthetic-db",
    config.password,
  ].filter(Boolean))
    assert(
      !text.includes(secret),
      "connection secrets must not enter definitions or persisted evidence",
    );
}
function nativeConnections(document, format) {
  if (format === "apipost") return document.global.db_link;
  const file = document.files.find(
    (item) => item.path === "settings/db_links.json",
  );
  assert(file, "directory bundle contains the native connection catalog");
  return JSON.parse(file.text);
}
function assertRedactedShell(document, format, config) {
  assertNoSecrets(document, config);
  const entries = nativeConnections(document, format);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.type, config.type === "postgres" ? "pg" : "mysql");
  assert.equal(entry.sort, 17);
  assert.deepEqual(Object.keys(entry.config), ["default"]);
  const defaults = entry.config.default;
  for (const key of ["host", "user", "password", "database", "auth_source"])
    assert.equal(
      defaults.db_config[key],
      "",
      key + " is not recovered from an active grant",
    );
  assert.equal(
    defaults.db_config.port,
    config.type === "postgres" ? 5432 : 3306,
  );
  assert.equal(defaults.ssh.enable, -1);
  assert.equal(defaults.ssh.auth_type, 1);
  assert.equal(defaults.ssh.port, 22);
  for (const key of [
    "host",
    "username",
    "password",
    "passphrase",
    "private_key",
  ])
    assert.equal(defaults.ssh[key], "");
}

export async function verifyNativeDatabaseExportFlow(config) {
  assert(["postgres", "mysql"].includes(config.type));
  const root = await mkdtemp(path.join(os.tmpdir(), "native-db-export-"));
  const observed = [];
  const peer = http.createServer((req, res) => {
    observed.push({ url: req.url, headers: req.headers });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ value: req.headers["x-db-value"] }));
  });
  let app;
  try {
    await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
    app = await createApp({ root, port: 0 });
    const call = async (route, body, expected = 200, method = "POST") => {
      const response = await fetch(app.url + "/api/" + route, {
        method,
        headers: {
          "content-type": "application/json",
          "x-local-token": app.token,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert.equal(response.status, expected, JSON.stringify(value));
      return value;
    };
    const source = nativeDatabaseFixture(
      `http://127.0.0.1:${peer.address().port}/`,
      config.type === "postgres" ? "pg" : "mysql",
    );
    source.global.db_link[0].sort = 17;
    const tasks = source.apis[1].request.pre_tasks;
    tasks[1].data.variables = [
      {
        name: "roundtripEnvironment",
        type: "environment",
        pattern: config.type === "mysql" ? "$[0][0].value" : "$[0].value",
        param_id: "env-row",
      },
      {
        name: "roundtripGlobal",
        type: "globals",
        pattern: config.type === "mysql" ? "$[0][0].value" : "$[0].value",
        param_id: "global-row",
      },
      {
        name: "roundtripTemporary",
        type: "variables",
        pattern: config.type === "mysql" ? "$[0][0].value" : "$[0].value",
        param_id: "temp-row",
      },
    ];
    tasks[2].data =
      'apt.setRequestHeader("x-db-value",shared+apt.environment.get("roundtripEnvironment"));apt.setRequestHeader("x-db-global",apt.globals.get("roundtripGlobal"));apt.setRequestHeader("x-db-temporary",pm.variables.get("roundtripTemporary"));';
    const originalSource = structuredClone(source);
    const foreign = await app.store.create("Unrelated project");
    const foreignBefore = await app.store.get(foreign.id);
    const empty = await app.store.create("Original database definitions");
    let original = await call(`projects/${empty.id}/import`, {
      document: source,
    });
    assert.deepEqual(source, originalSource);
    assert.equal(binding(original).sort, 17);
    const expectedPipeline = semanticPipeline(original);
    const execute = async (project) =>
      call(`projects/${project.id}/execute`, { request: request(project) });
    const grant = async (project) =>
      call(`projects/${project.id}/database-connections`, {
        ...config,
        name: "Explicit current disposable service",
        bindingId: binding(project).id,
      });
    const denied = async (project) => {
      const count = observed.length;
      assert.deepEqual(
        await call(
          `projects/${project.id}/database-connections`,
          undefined,
          200,
          "GET",
        ),
        [],
      );
      const result = await execute(project);
      assert.equal(result.outcome, "failed", JSON.stringify(result));
      assert.match(result.error, /未授权|失效/);
      assert.equal(
        observed.length,
        count,
        "missing grant stops before HTTP transport",
      );
    };
    const passed = async (project) => {
      const count = observed.length;
      const result = await execute(project);
      assert.equal(result.outcome, "passed", JSON.stringify(result));
      assert.equal(result.databaseQueries.length, 1);
      assert.equal(result.databaseQueries[0].status, "completed");
      assert.equal(observed.length, count + 1);
      assert.deepEqual(
        ["x-db-value", "x-db-global", "x-db-temporary"].map(
          (key) => observed.at(-1).headers[key],
        ),
        ["prefix-from-database", "from-database", "from-database"],
      );
      const disk = await new Store(root).get(project.id);
      assert.equal(disk.globalVariables.roundtripGlobal, "from-database");
      assert.equal(disk.globalVariables.roundtripTemporary, undefined);
      const environment = disk.environments.find(
        (entry) =>
          entry.id === (disk.currentEnvironmentId || disk.environments[0].id),
      );
      assert.equal(environment.variables.roundtripEnvironment, "from-database");
      assert.equal(environment.variables.roundtripTemporary, undefined);
      assertNoSecrets(disk, config);
      assert.deepEqual(semanticPipeline(disk), expectedPipeline);
      return disk;
    };
    await denied(original);
    await call(
      `projects/${foreign.id}/database-connections`,
      { ...config, name: "Wrong project", bindingId: binding(original).id },
      400,
    );
    assert.deepEqual(await app.store.get(foreign.id), foreignBefore);
    await grant(original);
    original = await passed(original);
    const originalBeforeCopies = await app.store.get(original.id);
    let finalCopy;
    for (const format of ["apipost", "apipost-directory"]) {
      let previous = original;
      for (let generation = 1; generation <= 2; generation++) {
        const before = await app.store.get(previous.id);
        const count = observed.length;
        await call(
          `projects/${previous.id}/export?format=${format}`,
          undefined,
          400,
          "GET",
        );
        const document = await call(
          `projects/${previous.id}/export?format=${format}&databaseMode=rebind`,
          undefined,
          200,
          "GET",
        );
        assertRedactedShell(document, format, config);
        assert.equal(
          observed.length,
          count,
          "definition export never queries the service or HTTP peer",
        );
        assert.deepEqual(
          await app.store.get(previous.id),
          before,
          "export never edits source state",
        );
        const copyInput = structuredClone(document);
        const created = await app.store.create(
          `${format} generation ${generation}`,
        );
        let copy = await call(`projects/${created.id}/import`, { document });
        assert.deepEqual(document, copyInput);
        assert.notEqual(copy.id, previous.id);
        assert.notEqual(binding(copy).id, binding(previous).id);
        assert.equal(binding(copy).sort, 17);
        assert.deepEqual(semanticPipeline(copy), expectedPipeline);
        assert.equal(
          request(copy).nativeTasks.before[1].data.resultShape,
          config.type === "mysql" ? "mysql-resultsets" : undefined,
        );
        await denied(copy);
        await grant(copy);
        copy = await passed(copy);
        previous = copy;
        finalCopy = copy;
      }
    }
    assert.deepEqual(
      await app.store.get(original.id),
      originalBeforeCopies,
      "roundtrips never write back to the source project",
    );
    assert.deepEqual(await app.store.get(foreign.id), foreignBefore);
    const plan = await call(`projects/${finalCopy.id}/plans`, {
      name: "Frozen rebound definition",
      environmentId: finalCopy.environments[0].id,
      steps: [{ request: request(finalCopy) }],
    });
    const run = await call(`projects/${finalCopy.id}/run`, { planId: plan.id });
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(run.results[0].databaseQueries[0].status, "completed");
    const frozenSource = await app.store.get(finalCopy.id);
    const frozenPlan = structuredClone(frozenSource.plans[0]);
    for (const format of ["apipost", "apipost-directory"])
      await call(
        `projects/${finalCopy.id}/export?format=${format}&databaseMode=rebind`,
        undefined,
        400,
        "GET",
      );
    const backup = await call(
      `projects/${finalCopy.id}/export?format=backup`,
      undefined,
      200,
      "GET",
    );
    assertNoSecrets(backup, config);
    let restored = await call("restore", { document: backup }, 201);
    assert.deepEqual(restored.plans[0], frozenPlan);
    assert.deepEqual(semanticPipeline(restored), expectedPipeline);
    await denied(restored);
    const beforeRestart = observed.length;
    await close(app.server);
    app = await createApp({ root, port: 0 });
    restored = await new Store(root).get(restored.id);
    assert.deepEqual(restored.plans[0], frozenPlan);
    await denied(restored);
    await denied(await app.store.get(original.id));
    assert.equal(observed.length, beforeRestart);
    const missing = await call(`projects/${restored.id}/run`, {
      planId: plan.id,
    });
    assert.equal(missing.status, "failed", JSON.stringify(missing));
    assert.equal(observed.length, beforeRestart);
    await grant(restored);
    const recoveredRun = await call(`projects/${restored.id}/run`, {
      planId: plan.id,
    });
    assert.equal(recoveredRun.status, "passed", JSON.stringify(recoveredRun));
    assert.equal(
      recoveredRun.results[0].databaseQueries[0].status,
      "completed",
    );
    assert.equal(observed.length, beforeRestart + 1);
    const recovered = await new Store(root).get(restored.id);
    assert(
      recovered.runs.some(
        (entry) => entry.id === recoveredRun.id && entry.status === "passed",
      ),
    );
    assert.deepEqual(recovered.plans[0], frozenPlan);
    assertNoSecrets(recovered, config);
    assert.deepEqual(await app.store.get(foreign.id), foreignBefore);
    assert.deepEqual(source, originalSource);
    assert.equal(
      observed.length,
      7,
      "five live migrations plus two frozen runs use the real peer",
    );
    console.log(
      "NATIVE_DATABASE_REBIND_EXPORT_PASSED",
      JSON.stringify({
        provider: config.type,
        formats: 2,
        generationsPerFormat: 2,
        realHTTPRequests: observed.length,
        backupRestartRegrant: true,
      }),
    );
  } finally {
    await close(app?.server);
    await close(peer);
    await rm(root, { recursive: true, force: true });
  }
}
