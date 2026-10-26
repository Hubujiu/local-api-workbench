import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import {
  importIntoProject,
  restoreProject,
  snapshotPlan,
} from "../src/core.mjs";
import { nativeMongoFixture } from "./fixtures/apipost-mongodb.mjs";

// Dedicated real MongoDB CI fixture. No original-runtime equivalence is inferred.
export async function verifyNativeMongoFlow(config) {
  const seen = [],
    echo = http.createServer((req, res) => {
      seen.push(req.headers["x-db-value"]);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ value: req.headers["x-db-value"] }));
    });
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "native-mongo-"));
  let app = await createApp({ root, port: 0 });
  const headers = () => ({
    "x-local-token": app.token,
    "content-type": "application/json",
  });
  const url = `http://127.0.0.1:${echo.address().port}/echo`;
  const convert = (options) => {
    const p = { requests: [], environments: [], settings: {} };
    importIntoProject(p, nativeMongoFixture(url, options));
    return p.requests[0];
  };
  const execute = async (p, request = p.requests[0]) => {
    const response = await fetch(
      app.url + "/api/projects/" + p.id + "/execute",
      { method: "POST", headers: headers(), body: JSON.stringify({ request }) },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const grant = async (p, extra = {}) => {
    const response = await fetch(
      app.url + "/api/projects/" + p.id + "/database-connections",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          ...config,
          name: "Explicit Mongo",
          bindingId: p.settings.apipostDatabases[0].id,
          ...extra,
        }),
      },
    );
    return { status: response.status, data: await response.json() };
  };
  const revoke = async (p, id) => {
    const response = await fetch(
      app.url + "/api/projects/" + p.id + "/database-connections",
      { method: "DELETE", headers: headers(), body: JSON.stringify({ id }) },
    );
    assert.equal(response.status, 200);
  };
  try {
    const p = await app.store.create("Mongo native"),
      foreign = await app.store.create("Foreign");
    const source = nativeMongoFixture(url),
      original = structuredClone(source);
    importIntoProject(p, source);
    await app.store.save(p);
    assert.equal((await execute(p)).outcome, "failed");
    assert.equal(seen.length, 0);
    assert.equal((await grant(p, { type: "postgres" })).status, 400);
    assert.equal(
      (await grant(p, { user: "missing-user", password: "not-real" })).status,
      400,
      "authenticated native grant requires explicit authSource",
    );
    let registration = await grant(p);
    assert.equal(registration.status, 200, JSON.stringify(registration));
    for (const [options, expected] of [
      [{ filter: { name: "one" } }, "one"],
      [{ filter: { name: "missing" } }, null],
      [{ filter: { n: { $gte: 1 } } }, new Set(["one", "two", "three"])],
      [{ filter: { name: "one" }, pattern: "$.n" }, { $numberInt: "1" }],
    ]) {
      const result = await execute(p, convert(options));
      assert.equal(result.outcome, "passed", JSON.stringify(result));
      assert.equal(result.databaseQueries[0].status, "completed");
      const value = (await app.store.get(p.id)).environments[0].variables
        .native_value;
      if (expected instanceof Set) assert(expected.has(value));
      else assert.deepEqual(value, expected);
      assert.equal(seen.at(-1), "prefix-" + String(value));
    }
    const calls = seen.length;
    const state = await app.store.get(p.id);
    state.environments[0].variables.probeA = "unchanged";
    await app.store.save(state);
    const missing = convert({ filter: { name: "one" } });
    missing.nativeTasks.before.find(
      (t) => t.type === "database",
    ).data.variables = [
      { name: "probeA", type: "environment", pattern: "$.name" },
      { name: "probeB", type: "environment", pattern: "$.missing" },
    ];
    assert.equal((await execute(p, missing)).outcome, "failed");
    assert.equal(seen.length, calls);
    const unchanged = await app.store.get(p.id);
    assert.equal(unchanged.environments[0].variables.probeA, "unchanged");
    assert.equal(unchanged.environments[0].variables.probeB, undefined);
    const serverError = await execute(
      p,
      convert({ filter: { $unknown_native_test: 1 } }),
    );
    assert.equal(serverError.outcome, "failed");
    assert.match(serverError.error, /operator|unknown/i);
    assert.equal(seen.length, calls);
    assert.equal((await execute(foreign, p.requests[0])).outcome, "failed");
    assert.equal(seen.length, calls);
    await revoke(p, registration.data.id);
    assert.equal((await execute(p)).outcome, "failed");
    assert.equal(seen.length, calls);
    const badAuth = await grant(p, {
      user: "missing-native-fixture-user",
      password: "not-real",
      authSource: "admin",
    });
    assert.equal(badAuth.status, 200);
    const authFailure = await execute(p);
    assert.equal(authFailure.outcome, "failed");
    assert.match(authFailure.error, /auth|认证/i);
    assert.equal(seen.length, calls);
    await revoke(p, badAuth.data.id);
    registration = await grant(p);
    assert.equal(registration.status, 200);
    const phasedSource = nativeMongoFixture(url);
    const operation = (id, name, type, pattern) => ({
      id,
      name: id,
      type: "database",
      enabled: 1,
      data: {
        connectionId: "database",
        method: "findone",
        collectionName: "items",
        query: '{"name":"one"}',
        isConsoleOutput: -1,
        variables: [{ name, type, pattern }],
      },
    });
    phasedSource.apis[1].request.post_tasks.push(
      operation("global-after", "mongoGlobal", "globals", "$.name"),
      operation("temporary-after", "mongoTemporary", "variables", "$.n"),
      {
        id: "verify-after",
        name: "Verify scopes",
        type: "customScript",
        enabled: 1,
        data: 'pm.test("document scopes",()=>{pm.expect(pm.globals.get("mongoGlobal")).to.equal("one");pm.expect(JSON.stringify(pm.variables.get("mongoTemporary"))).to.equal(\'{"$numberInt":"1"}\');});',
      },
    );
    const phased = { requests: [], environments: [], settings: {} };
    importIntoProject(phased, phasedSource);
    const phaseResult = await execute(p, phased.requests[0]);
    assert.equal(phaseResult.outcome, "passed", JSON.stringify(phaseResult));
    assert.equal(phaseResult.databaseQueries.length, 3);
    const saved = await app.store.get(p.id);
    assert.equal(saved.globalVariables.mongoGlobal, "one");
    assert.equal(saved.globalVariables.mongoTemporary, undefined);
    assert.equal(saved.environments[0].variables.mongoTemporary, undefined);
    saved.plans = [
      snapshotPlan({
        name: "Mongo frozen",
        environmentId: saved.environments[0].id,
        steps: [{ request: saved.requests[0] }],
      }),
    ];
    await app.store.save(saved);
    const restored = restoreProject(saved);
    await app.store.save(restored);
    const prior = seen.length;
    assert.equal((await execute(restored)).outcome, "failed");
    assert.equal(seen.length, prior);
    assert.equal((await grant(restored)).status, 200);
    assert.equal((await execute(restored)).outcome, "passed");
    const beforeRestart = await app.store.get(restored.id);
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    app = await createApp({ root, port: 0 });
    const reopened = await app.store.get(restored.id);
    assert.deepEqual(reopened.environments, beforeRestart.environments);
    assert.deepEqual(reopened.plans, beforeRestart.plans);
    const beforeNoGrant = seen.length;
    assert.equal((await execute(restored)).outcome, "failed");
    assert.equal(seen.length, beforeNoGrant);
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
    assert.equal(result.recordSaved, true);
    assert(
      (await app.store.get(restored.id)).runs.some(
        (run) =>
          run.id === result.id &&
          run.results[0].databaseQueries[0].status === "completed",
      ),
    );
    const disk = JSON.stringify(await app.store.get(p.id));
    assert(!disk.includes("discard-this-fictional-password"));
    assert(!disk.includes("not-real"));
    assert(!disk.includes("source-auth-not-inherited"));
    assert.deepEqual(source, original);
    console.log("REAL_NATIVE_MONGODB_DOCUMENT_NULL_SCOPES_HTTP_RESTORE_PASS");
  } finally {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    echo.closeAllConnections();
    await new Promise((r) => echo.close(r));
    await rm(root, { recursive: true, force: true });
  }
}
