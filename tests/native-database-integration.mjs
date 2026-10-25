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
