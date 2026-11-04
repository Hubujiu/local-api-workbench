import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DatabaseSessions } from "../src/database-sessions.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
import { runScript } from "../src/scripts.mjs";
const script = (data) => ({ type: "customScript", enabled: 1, data });
const database = (
  connectionId = "fixture",
  variables = [{ name: "value", type: "environment", pattern: "$[0].value" }],
) => ({
  type: "database",
  enabled: 1,
  data: {
    connectionId,
    query: "SELECT value FROM records",
    isConsoleOutput: 1,
    variables,
  },
});
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "native-tasks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "fixture.db");
  const db = new DatabaseSync(filename);
  db.exec(
    "CREATE TABLE records(value TEXT);INSERT INTO records VALUES('from-database')",
  );
  db.close();
  const sessions = new DatabaseSessions();
  t.after(() => sessions.close());
  const connection = sessions.register("one", { name: "synthetic", filename });
  return {
    sessions,
    id: connection.id,
    query: (operation, signal) => sessions.query("one", operation, signal),
  };
}
test("native mixed phase preserves lexical scope and database order with real SQLite", async (t) => {
  const f = await fixture(t);
  const tasks = [
    script('const lexical="shared";pm.environment.set("value","before");'),
    database(f.id),
    script(
      'pm.test("shared",()=>pm.expect(lexical).to.equal("shared"));pm.test("ordered",()=>pm.expect(pm.environment.get("value")).to.equal("from-database"));apt.setRequestHeader("x-database",pm.environment.get("value"));',
    ),
  ];
  const result = await runNativeTaskPhase(
    tasks,
    { variables: {}, request: { url: "http://example.test", headers: [] } },
    { databaseQuery: f.query },
  );
  assert.deepEqual(
    result.tests.map((x) => x.passed),
    [true, true],
  );
  assert.equal(
    result.request.headers.find((x) => x.key === "x-database").value,
    "from-database",
  );
  assert.equal(result.databaseQueries[0].status, "completed");
  assert.equal(result.networkRequests.length, 0);
  assert.equal(JSON.stringify(tasks).includes("filename"), false);
  assert.equal(
    (
      await runScript(
        "console.log(typeof lexical,typeof __nativeDatabaseTask,typeof __nativeDatabaseBridge);",
        { variables: {} },
      )
    ).logs[0],
    "undefined undefined undefined",
  );
});
test("native database permissions are explicit, project bound, revocable and never recreated", async (t) => {
  const f = await fixture(t),
    tasks = [database(f.id)];
  assert.throws(() => runNativeTaskPhase(tasks, { variables: {} }), /未授权/);
  await assert.rejects(
    runNativeTaskPhase(
      tasks,
      { variables: {} },
      { databaseQuery: (op, signal) => f.sessions.query("two", op, signal) },
    ),
    /失效|未授权/,
  );
  f.sessions.revoke("one", f.id);
  await assert.rejects(
    runNativeTaskPhase(tasks, { variables: {} }, { databaseQuery: f.query }),
    /失效|未授权/,
  );
});
test("native database validation rejects writes, interpolation, excessive calls and malformed extraction before execution", () => {
  for (const patch of [
    { query: "DELETE FROM records" },
    { query: "SELECT {{sql}}" },
    { variables: [{ name: "__proto__", type: "environment", pattern: "$" }] },
    {
      variables: [{ name: "x", type: "environment", pattern: "$.constructor" }],
    },
    { password: "forbidden" },
  ]) {
    const task = database();
    Object.assign(task.data, patch);
    assert.throws(() =>
      runNativeTaskPhase(
        [task],
        { variables: {} },
        { databaseQuery: () => assert.fail("must not query") },
      ),
    );
  }
  assert.throws(
    () =>
      runNativeTaskPhase(
        Array.from({ length: 6 }, () => database()),
        { variables: {} },
        { databaseQuery: () => {} },
      ),
    /最多5/,
  );
});
test("disabled native tasks do not query; failed extraction stops later scripts without partial success", async (t) => {
  const f = await fixture(t),
    disabled = database(f.id);
  disabled.enabled = -1;
  assert.equal(
    (
      await runNativeTaskPhase([disabled, script('console.log("ok")')], {
        variables: {},
      })
    ).databaseQueries.length,
    0,
  );
  const tasks = [
    database(f.id, [
      { name: "first", type: "environment", pattern: "$[0].value" },
      { name: "missing", type: "environment", pattern: "$[1].value" },
    ]),
    script('throw Error("later-script-ran")'),
  ];
  await assert.rejects(
    runNativeTaskPhase(tasks, { variables: {} }, { databaseQuery: f.query }),
    (error) => {
      assert.match(error.message, /提取路径不存在/);
      assert.equal(error.databaseQueries[0].status, "failed");
      return true;
    },
  );
});
test("database cancellation and unchanged script deadline abort the broker and suppress late results", async () => {
  const controller = new AbortController();
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  let brokerSignal;
  const pending = runNativeTaskPhase(
    [database()],
    { variables: {} },
    {
      signal: controller.signal,
      databaseQuery: async (_op, signal) => {
        brokerSignal = signal;
        began();
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
        return { rows: [{ value: "late" }] };
      },
    },
  );
  await started;
  controller.abort();
  await assert.rejects(pending, /取消/);
  assert.equal(brokerSignal.aborted, true);
  await assert.rejects(
    runNativeTaskPhase([script("while(true){}")], { variables: {} }),
    /interrupt|超时/,
  );
});
test("mixed database phase feeds an actual HTTP request and retains independent scope state", async (t) => {
  const http = await import("node:http");
  const { executeRequest } = await import("../src/runtime.mjs");
  const f = await fixture(t);
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ value: req.headers["x-database"] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await runNativeTaskPhase(
    [
      script('const prefix="prefix-";'),
      database(f.id),
      script(
        'apt.setRequestHeader("x-database",prefix+pm.environment.get("value"));',
      ),
    ],
    {
      variables: {},
      request: {
        method: "GET",
        url: `http://127.0.0.1:${server.address().port}/`,
        headers: [],
      },
    },
    { databaseQuery: f.query },
  );
  const response = await executeRequest(result.request);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    value: "prefix-from-database",
  });
  const independent = await runNativeTaskPhase(
    [
      script(
        'pm.test("no leak",()=>pm.expect(pm.environment.get("value")).to.equal(undefined));',
      ),
    ],
    { variables: {} },
  );
  assert.equal(independent.tests[0].passed, true);
});

test("MySQL resultsets retain native nested extraction and console shape without changing ordinary rows", async () => {
  const { databaseAssignments, normalizeDatabaseOperations } = await import(
    "../src/script-database-tasks.mjs"
  );
  const operation = {
    connectionId: "fixture",
    query: "SELECT 1",
    isConsoleOutput: 1,
    resultShape: "mysql-resultsets",
    variables: [
      { name: "value", type: "environment", pattern: "$[0][0].value" },
    ],
  };
  const input = {
    variables: {},
    request: { url: "http://127.0.0.1:1/", method: "GET", headers: [] },
  };
  const tasks = [{ type: "database", enabled: 1, data: operation }];
  const result = await runNativeTaskPhase(tasks, input, {
    databaseQuery: async () => ({ rows: [{ value: "wrapped" }] }),
  });
  assert.equal(result.variables.value, "wrapped");
  assert(result.logs.some((l) => JSON.stringify(l).includes("[[{")));
  assert.throws(
    () =>
      databaseAssignments(
        {
          ...operation,
          variables: [
            { name: "value", type: "environment", pattern: "$[0].value" },
          ],
        },
        { rows: [{ value: "wrapped" }] },
      ),
    /路径不存在/,
  );
  assert.throws(() =>
    normalizeDatabaseOperations([{ ...operation, resultShape: "arbitrary" }]),
  );
});
