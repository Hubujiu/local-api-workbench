import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/server.mjs";
import { importIntoProject, restoreProject } from "../src/core.mjs";
import { nativeDatabaseFixture } from "./fixtures/apipost-database.mjs";
export async function verifyNativeDatabaseScopes(config) {
  const root = await mkdtemp(path.join(tmpdir(), "native-scopes-"));
  const app = await createApp({ root, port: 0 });
  const observed = [];
  const echo = http.createServer((req, res) => {
    observed.push(req.headers);
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  try {
    const p = await app.store.create("scopes"),
      other = await app.store.create("other");
    const doc = nativeDatabaseFixture(
        `http://127.0.0.1:${echo.address().port}/`,
      ),
      api = doc.apis[1];
    api.request.pre_tasks[0].data =
      'apt.environment.set("shared","environment");apt.globals.set("shared","global");';
    api.request.pre_tasks[1].data.variables = [
      { name: "shared", type: "variables", pattern: "$[0].value" },
      { name: "dbGlobal", type: "globals", pattern: "$[0].value" },
      { name: "dbEnvironment", type: "environment", pattern: "$[0].value" },
    ];
    api.request.pre_tasks[2].data =
      'apt.setRequestHeader("x-local",pm.variables.get("shared"));apt.setRequestHeader("x-environment",apt.environment.get("shared"));apt.setRequestHeader("x-global",apt.globals.get("shared"));';
    api.request.post_tasks[0].data =
      'pm.test("temporary remains within request",()=>pm.expect(pm.variables.get("shared")).to.equal("from-database"));pm.test("global",()=>pm.expect(pm.globals.get("dbGlobal")).to.equal("from-database"));';
    importIntoProject(p, doc);
    await app.store.save(p);
    const request = p.requests[0],
      bindingId = p.settings.apipostDatabases[0].id;
    assert.deepEqual(
      request.nativeTasks.before[1].data.variables.map((v) => v.type),
      ["temporary", "global", "environment"],
    );
    const headers = {
      "content-type": "application/json",
      "x-local-token": app.token,
    };
    const call = async (projectId, request) => {
      const response = await fetch(
        app.url + "/api/projects/" + projectId + "/execute",
        { method: "POST", headers, body: JSON.stringify({ request }) },
      );
      assert.equal(response.ok, true);
      return response.json();
    };
    const grant = await fetch(
      app.url + "/api/projects/" + p.id + "/database-connections",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...config,
          name: "explicit scoped fixture",
          bindingId,
        }),
      },
    );
    assert.equal(grant.ok, true);
    const result = await call(p.id, request);
    assert.equal(result.outcome, "passed", JSON.stringify(result));
    assert.equal(observed.length, 1);
    assert.deepEqual(
      ["x-local", "x-environment", "x-global"].map((k) => observed[0][k]),
      ["from-database", "environment", "global"],
    );
    const saved = await app.store.get(p.id);
    assert.equal(saved.globalVariables.dbGlobal, "from-database");
    assert.equal(saved.globalVariables.shared, "global");
    const environment = saved.environments.find(
      (e) => e.id === (saved.currentEnvironmentId || saved.environments[0].id),
    );
    assert.equal(environment.variables.dbEnvironment, "from-database");
    assert.equal(environment.variables.shared, "environment");
    const follow = {
      url: request.url,
      beforeScript:
        'pm.test("local cleared",()=>pm.expect(pm.variables.get("shared")).to.equal("environment"));apt.setRequestHeader("x-persisted",pm.globals.get("dbGlobal"));',
    };
    assert.equal((await call(p.id, follow)).outcome, "passed");
    assert.equal(observed[1]["x-persisted"], "from-database");
    const foreign = {
      url: request.url,
      beforeScript:
        'pm.test("no cross project",()=>pm.expect(pm.globals.get("dbGlobal")).to.equal(undefined));pm.test("no environment leak",()=>pm.expect(pm.environment.get("dbEnvironment")).to.equal(undefined));',
    };
    assert.equal((await call(other.id, foreign)).outcome, "passed");
    const restored = restoreProject(saved);
    await app.store.save(restored);
    assert.equal(restored.globalVariables.dbGlobal, "from-database");
    assert.deepEqual(restored.requests[0].nativeTasks, request.nativeTasks);
    const denied = await call(restored.id, request);
    assert.equal(denied.outcome, "failed");
    assert.match(denied.error, /未授权|失效/);
    assert.equal(observed.length, 3);
  } finally {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => echo.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
