import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import {
  importIntoProject,
  restoreProject,
  snapshotPlan,
} from "../src/core.mjs";
import { mutateRedis } from "../src/redis.mjs";
import { nativeRedisFixture } from "./fixtures/apipost-redis.mjs";

// Only called by the dedicated CI real-Redis service fixture, not a mock server.
export async function verifyNativeRedisFlow(config) {
  const prefix = "localapi:native:" + randomUUID();
  for (const [name, value] of [
    ["empty", ""],
    ["json", '{"literal":true}'],
    ["number", "123"],
  ])
    await mutateRedis({
      ...config,
      allowWrite: true,
      command: ["SET", prefix + ":" + name, value, "EX", "60"],
    });
  const seen = [],
    echo = http.createServer((req, res) => {
      seen.push(req.headers["x-db-value"]);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ value: req.headers["x-db-value"] }));
    });
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "native-redis-"));
  let app = await createApp({ root, port: 0 });
  const headers = () => ({
    "content-type": "application/json",
    "x-local-token": app.token,
  });
  const execute = async (p, request = p.requests[0]) => {
    const response = await fetch(
      app.url + "/api/projects/" + p.id + "/execute",
      { method: "POST", headers: headers(), body: JSON.stringify({ request }) },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const grant = async (p, type = "redis") => {
    const response = await fetch(
      app.url + "/api/projects/" + p.id + "/database-connections",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          ...config,
          type,
          name: "Disposable Redis",
          bindingId: p.settings.apipostDatabases[0].id,
        }),
      },
    );
    return { status: response.status, data: await response.json() };
  };
  try {
    const p = await app.store.create("Redis native"),
      foreign = await app.store.create("Foreign");
    const source = nativeRedisFixture(
        `http://127.0.0.1:${echo.address().port}/echo`,
      ),
      sourceBefore = structuredClone(source);
    importIntoProject(p, source);
    await app.store.save(p);
    assert.equal((await execute(p)).outcome, "failed");
    assert.equal(seen.length, 0);
    assert.equal((await grant(p, "postgres")).status, 400);
    const granted = await grant(p);
    assert.equal(granted.status, 200, JSON.stringify(granted));
    for (const [method, query, value] of [
      ["get", { key: "localapi:fixture" }, "hello"],
      ["hget", { key: "localapi:hash", field: "a" }, "1"],
      ["exists", { key: "localapi:fixture" }, 1],
      ["exists", { key: prefix + ":missing" }, 0],
      ["get", { key: prefix + ":missing" }, null],
      ["get", { key: prefix + ":empty" }, ""],
      ["get", { key: prefix + ":json" }, '{"literal":true}'],
      ["get", { key: prefix + ":number" }, "123"],
    ]) {
      const sample = { requests: [], environments: [], settings: {} };
      importIntoProject(
        sample,
        nativeRedisFixture(`http://127.0.0.1:${echo.address().port}/echo`, {
          method,
          query: JSON.stringify(query),
        }),
      );
      const result = await execute(p, sample.requests[0]);
      assert.equal(result.outcome, "passed", JSON.stringify(result));
      assert.equal(seen.at(-1), "prefix-" + String(value));
      const current = await app.store.get(p.id);
      assert.equal(current.environments[0].variables.native_value, value);
    }
    assert.equal((await execute(foreign, p.requests[0])).outcome, "failed");
    assert.equal(seen.length, 8);
    const invalid = structuredClone(p.requests[0]);
    invalid.nativeTasks.before.find((t) => t.type === "database").data.query =
      '["SET","localapi:fixture","bad"]';
    const writeResponse = await fetch(
      app.url + "/api/projects/" + p.id + "/execute",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ request: invalid }),
      },
    );
    assert.equal(writeResponse.status, 400);
    assert.equal(seen.length, 8);
    const wrongTypeSource = nativeRedisFixture(
      `http://127.0.0.1:${echo.address().port}/echo`,
      { method: "get", query: '{"key":"localapi:hash"}' },
    );
    const wrongTypeProject = { requests: [], environments: [], settings: {} };
    importIntoProject(wrongTypeProject, wrongTypeSource);
    const wrongType = await execute(p, wrongTypeProject.requests[0]);
    assert.equal(wrongType.outcome, "failed");
    assert.match(wrongType.error, /WRONGTYPE/);
    assert.equal(seen.length, 8);
    const phasedSource = nativeRedisFixture(
      `http://127.0.0.1:${echo.address().port}/echo`,
    );
    const task = (id, method, query, name, type) => ({
      id,
      name: id,
      type: "database",
      enabled: 1,
      data: {
        connectionId: "database",
        method,
        query: JSON.stringify(query),
        isConsoleOutput: -1,
        variables: [{ name, type, pattern: "$[0]" }],
      },
    });
    phasedSource.apis[1].request.post_tasks.push(
      task(
        "global-after",
        "hget",
        { key: "localapi:hash", field: "a" },
        "redisGlobal",
        "globals",
      ),
      task(
        "temporary-after",
        "exists",
        { key: "localapi:fixture" },
        "redisTemporary",
        "variables",
      ),
      {
        id: "check-after",
        name: "Check scopes",
        type: "customScript",
        enabled: 1,
        data: 'pm.test("after scopes",()=>{pm.expect(pm.globals.get("redisGlobal")).to.equal("1");pm.expect(pm.variables.get("redisTemporary")).to.equal(1);});',
      },
    );
    const phased = { requests: [], environments: [], settings: {} };
    importIntoProject(phased, phasedSource);
    const phaseResult = await execute(p, phased.requests[0]);
    assert.equal(phaseResult.outcome, "passed", JSON.stringify(phaseResult));
    assert.equal(phaseResult.databaseQueries.length, 3);
    const phaseSaved = await app.store.get(p.id);
    assert.equal(phaseSaved.globalVariables.redisGlobal, "1");
    assert.equal(
      phaseSaved.environments[0].variables.redisTemporary,
      undefined,
    );
    const saved = await app.store.get(p.id);
    saved.plans = [
      snapshotPlan({
        name: "Redis frozen",
        environmentId: saved.environments[0].id,
        steps: [{ request: saved.requests[0] }],
      }),
    ];
    await app.store.save(saved);
    const restored = restoreProject(saved);
    await app.store.save(restored);
    assert.equal((await execute(restored)).outcome, "failed");
    assert.equal(seen.length, 9);
    assert.equal((await grant(restored)).status, 200);
    assert.equal((await execute(restored)).outcome, "passed");
    assert.equal(seen.length, 10);
    await fetch(app.url + "/api/projects/" + p.id + "/database-connections", {
      method: "DELETE",
      headers: headers(),
      body: JSON.stringify({ id: granted.data.id }),
    });
    assert.equal((await execute(p)).outcome, "failed");
    assert.equal(seen.length, 10);
    const beforeRestart = await app.store.get(restored.id);
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    app = await createApp({ root, port: 0 });
    const afterRestart = await app.store.get(restored.id);
    assert.deepEqual(afterRestart.environments, beforeRestart.environments);
    assert.deepEqual(afterRestart.plans, beforeRestart.plans);
    assert.equal((await execute(restored)).outcome, "failed");
    assert.equal(seen.length, 10);
    assert.equal((await grant(restored)).status, 200);
    const response = await fetch(
      app.url + "/api/projects/" + restored.id + "/run",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ planId: restored.plans[0].id }),
      },
    );
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.equal(result.recordSaved, true, JSON.stringify(result));
    const recorded = (await app.store.get(restored.id)).runs.find(
      (run) => run.id === result.id,
    );
    assert(recorded);
    assert.equal(recorded.results[0].databaseQueries[0].status, "completed");
    assert.equal(seen.length, 11);
    assert(
      !JSON.stringify(await app.store.get(p.id)).includes(
        "discard-this-fictional-password",
      ),
    );
    assert.deepEqual(source, sourceBefore);
    console.log(
      "REAL_NATIVE_REDIS_HTTP_SCALARS_RESTORE_RESTART_ISOLATION_PASS",
    );
  } finally {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    echo.closeAllConnections();
    await new Promise((r) => echo.close(r));
    await rm(root, { recursive: true, force: true });
  }
}
