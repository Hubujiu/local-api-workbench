import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { executeRequest } from "../src/runtime.mjs";

// Receives only an explicitly supplied disposable test database configuration.
export async function verifyNativeDatabaseFlow(config) {
  const sessions = new DatabaseSessions(),
    binding = sessions.register("native-fixture", {
      ...config,
      name: "native fixture",
    });
  const script = (data) => ({ type: "customScript", enabled: 1, data });
  const operation = {
    type: "database",
    enabled: 1,
    data: {
      connectionId: binding.id,
      query: "SELECT 'from-database' AS value",
      isConsoleOutput: -1,
      variables: [
        { name: "native_value", type: "environment", pattern: "$[0].value" },
      ],
    },
  };
  const tasks = [
    script(
      'const lexical="same-scope";pm.environment.set("native_value","before");',
    ),
    operation,
    script(
      'pm.test("lexical",()=>pm.expect(lexical).to.equal("same-scope"));apt.setRequestHeader("x-db-value",pm.environment.get("native_value")+"-after");',
    ),
  ];
  const server = http.createServer((request, response) => {
    response.end(JSON.stringify({ value: request.headers["x-db-value"] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const input = {
    variables: {},
    request: {
      method: "GET",
      url: `http://127.0.0.1:${server.address().port}/`,
      headers: [],
    },
  };
  const options = {
    databaseQuery: (query, signal) =>
      sessions.query("native-fixture", query, signal),
  };
  try {
    const snapshot = JSON.stringify(tasks);
    const result = await runNativeTaskPhase(tasks, input, options);
    assert.equal(result.tests[0].passed, true);
    assert.equal(result.databaseQueries[0].status, "completed");
    const response = await executeRequest(result.request);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), {
      value: "from-database-after",
    });
    assert.equal(JSON.stringify(tasks), snapshot);
    assert.deepEqual(input.variables, {});
    assert.deepEqual(input.request.headers, []);
    await assert.rejects(
      runNativeTaskPhase(tasks, input, {
        databaseQuery: (query, signal) =>
          sessions.query("foreign", query, signal),
      }),
      /未授权|失效/,
    );
    sessions.revoke("native-fixture", binding.id);
    await assert.rejects(
      runNativeTaskPhase(tasks, input, options),
      /未授权|失效/,
    );
    assert.equal(sessions.list("native-fixture").length, 0);
  } finally {
    sessions.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function verifyNativeImportHTTPFlow(config) {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createApp } = await import("../src/server.mjs");
  const { importIntoProject } = await import("../src/core.mjs");
  const { nativeDatabaseFixture } = await import(
    "./fixtures/apipost-database.mjs"
  );
  const root = await mkdtemp(join(tmpdir(), "native-pg-api-"));
  let app = await createApp({ root, port: 0 });
  let count = 0;
  const echo = http.createServer((req, res) => {
    count++;
    res.end(JSON.stringify({ value: req.headers["x-db-value"] }));
  });
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  try {
    const project = await app.store.create("native import fixture"),
      foreign = await app.store.create("foreign");
    const source = nativeDatabaseFixture(
      `http://127.0.0.1:${echo.address().port}/`,
    );
    importIntoProject(project, source);
    await app.store.save(project);
    const bindingId = project.settings.apipostDatabases[0].id,
      request = project.requests[0];
    const headers = () => ({
      "content-type": "application/json",
      "x-local-token": app.token,
    });
    const endpoint = () =>
      app.url + "/api/projects/" + project.id + "/database-connections";
    const execute = async (projectId = project.id) => {
      const response = await fetch(
        app.url + "/api/projects/" + projectId + "/execute",
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ request }),
        },
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    const grantConfig = {
      ...config,
      name: "explicit current project",
      bindingId,
    };
    assert.equal((await execute()).outcome, "failed");
    assert.equal(count, 0);
    for (const badHeaders of [
      { "content-type": "application/json" },
      { ...headers(), Origin: "https://untrusted.example" },
    ])
      assert.equal(
        (
          await fetch(endpoint(), {
            method: "POST",
            headers: badHeaders,
            body: JSON.stringify(grantConfig),
          })
        ).status,
        403,
      );
    assert.equal(
      (
        await fetch(endpoint(), {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ ...grantConfig, type: "mysql" }),
        })
      ).ok,
      false,
    );
    const grantResponse = await fetch(endpoint(), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(grantConfig),
    });
    assert.equal(grantResponse.ok, true);
    const grant = await grantResponse.json();
    assert.equal(grant.bindingId, bindingId);
    const passed = await execute();
    assert.equal(passed.outcome, "passed", JSON.stringify(passed));
    assert.equal(passed.databaseQueries[0].status, "completed");
    assert.equal(count, 1);
    assert.equal((await execute(foreign.id)).outcome, "failed");
    assert.equal(count, 1);
    const disk = await app.store.get(project.id);
    assert.equal(
      JSON.stringify(disk).includes("discard-this-fictional-password"),
      false,
    );
    assert.equal(
      JSON.stringify(disk.settings.apipostDatabases).includes(config.host),
      false,
    );
    assert.equal(
      disk.history.at(-1)?.databaseQueries?.[0]?.status === "completed" ||
        disk.history[0]?.databaseQueries?.[0]?.status === "completed",
      true,
    );
    assert.equal(
      (
        await fetch(endpoint(), {
          method: "DELETE",
          headers: headers(),
          body: JSON.stringify({ id: grant.id }),
        })
      ).ok,
      true,
    );
    assert.equal((await execute()).outcome, "failed");
    assert.equal(count, 1);
    const rebound = await fetch(endpoint(), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(grantConfig),
    });
    assert.equal(rebound.ok, true);
    await new Promise((resolve) => app.server.close(resolve));
    app = await createApp({ root, port: 0 });
    assert.equal((await execute()).outcome, "failed");
    assert.equal(count, 1);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => echo.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
