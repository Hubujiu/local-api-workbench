import assert from "node:assert/strict";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
const base = {
  type: "clickhouse",
  host: "127.0.0.1",
  port: 8123,
  user: "tester",
  password: "local-fixture-only",
  database: "fixture",
};
const value = "quote';semi;tab\tline\nslash\\N\0";
const result = await queryRemoteDatabase({
  ...base,
  sql: "SELECT {p0:String} AS value, {p1:UInt64} AS large, {p2:Nullable(String)} AS missing",
  parameters: [value, "18446744073709551615", null],
});
assert.equal(result.rows[0].value, value);
assert.equal(result.rows[0].large, "18446744073709551615");
assert.equal(result.rows[0].missing, null);
const named = await queryRemoteDatabase({
  ...base,
  sql: "SELECT {answer:UInt32} AS answer",
  parameters: { answer: 42 },
});
assert.equal(named.rows[0].answer, 42);
const limited = await queryRemoteDatabase({
  ...base,
  sql: "SELECT number FROM numbers(2000)",
});
assert.equal(limited.rows.length, 1000);
assert.equal(limited.truncated, true);
await assert.rejects(
  queryRemoteDatabase({ ...base, sql: "DELETE FROM fixture.items" }),
  /SELECT/,
);
const url = new URL("http://127.0.0.1:8123/");
url.searchParams.set(
  "query",
  "CREATE TABLE fixture.forbidden_by_get(n UInt8) ENGINE Memory",
);
const denied = await fetch(url, {
  headers: {
    Authorization:
      "Basic " + Buffer.from("tester:local-fixture-only").toString("base64"),
  },
});
assert.equal(
  denied.ok,
  false,
  "server must enforce readonly GET even for an otherwise privileged fixture user",
);
const absent = await queryRemoteDatabase({
  ...base,
  sql: "SELECT count() AS n FROM system.tables WHERE database='fixture' AND name='forbidden_by_get'",
});
assert.equal(absent.rows[0].n, "0");

await assert.rejects(
  queryRemoteDatabase({ ...base, sql: "SELECT 1 SETTINGS readonly=0" }),
  /ClickHouse/,
);
url.searchParams.set("query", "SELECT 1 SETTINGS readonly=0");
const cannotUpgrade = await fetch(url, {
  headers: {
    Authorization:
      "Basic " + Buffer.from("tester:local-fixture-only").toString("base64"),
  },
});
assert.equal(
  cannotUpgrade.ok,
  false,
  "GET read-only mode cannot be upgraded by query settings",
);
// These cases execute against the disposable ClickHouse CI service, not a
// simulated JSON response. Decimal inputs are strings, never JS numbers.
const decimals = [
  [32, 8, "0.12345679"],
  [64, 17, "0.12345678901234567"],
  [128, 37, "0.1234567890123456789012345678901234567"],
  [256, 75, "0." + "123456789".repeat(8) + "123"],
];
for (const [bits, scale, exact] of decimals) {
  const selected = await queryRemoteDatabase({
    ...base,
    sql: `SELECT toDecimal${bits}({positive:String}, ${scale}) AS positive,
      toDecimal${bits}({negative:String}, ${scale}) AS negative,
      toDecimal${bits}('0', 0) AS zero,
      CAST(NULL AS Nullable(Decimal${bits}(${scale}))) AS missing,
      [toDecimal${bits}({positive:String}, ${scale}),
       toDecimal${bits}({negative:String}, ${scale})] AS values`,
    parameters: { positive: exact, negative: "-" + exact },
  });
  assert.deepEqual(selected.rows, [
    {
      positive: exact,
      negative: "-" + exact,
      zero: "0",
      missing: null,
      values: [exact, "-" + exact],
    },
  ]);
  const nullableArray = await queryRemoteDatabase({
    ...base,
    sql: `SELECT [CAST(toDecimal${bits}({value:String}, ${scale}) AS Nullable(Decimal${bits}(${scale}))), NULL] AS values`,
    parameters: { value: exact },
  });
  assert.deepEqual(nullableArray.rows, [{ values: [exact, null] }]);
}

console.log("REAL_CLICKHOUSE_DECIMAL_MATRIX_PASS");

// Exercise the existing project API end to end, without script VM execution.
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const path = await import("node:path");
const http = await import("node:http");
const { createApp } = await import("../src/server.mjs");
const root = await mkdtemp(path.join(tmpdir(), "clickhouse-decimal-project-"));
let app;
let hits = 0;
const echo = http.createServer((req, res) => {
  hits++;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ exact: req.headers["x-exact"] }));
});
await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
const closeApp = async () => {
  if (!app) return;
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  app = undefined;
};
try {
  app = await createApp({ root, port: 0 });
  const call = async (
    route,
    data,
    method = data === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        "content-type": "application/json",
        "x-local-token": app.token,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const body = await response.json();
    assert.equal(response.ok, true, JSON.stringify(body));
    return body;
  };
  const project = await call("/api/projects", {
    name: "Decimal exact roundtrip",
  });
  const route = (id, action) => `/api/projects/${id}/${action}`;
  const grant = (id) =>
    call(route(id, "database-connections"), {
      ...base,
      name: "decimal fixture",
    });
  const connection = await grant(project.id);
  const exact = decimals[3][2];
  const request = (connectionId) => ({
    name: "Decimal through HTTP",
    method: "GET",
    url: `http://127.0.0.1:${echo.address().port}/echo`,
    headers: [{ key: "X-Exact", value: "{{exact}}", enabled: true }],
    before: [
      {
        type: "database",
        connectionId,
        sql: "SELECT toDecimal256({p0:String}, 75) AS exact",
        parameters: [exact],
        name: "exact",
        path: "$.rows[0].exact",
      },
    ],
  });
  const plan = await call(route(project.id, "plans"), {
    steps: [{ request: request(connection.id) }],
  });
  const assertPassed = (run) => {
    assert.equal(run.status, "passed", JSON.stringify(run));
    assert.equal(run.variables.exact, exact);
    assert.deepEqual(JSON.parse(run.results[0].response.body), { exact });
  };
  const run = await call(route(project.id, "run"), { planId: plan.id });
  assertPassed(run);
  const backup = await call(route(project.id, "export"));
  assertPassed(backup.runs.find((item) => item.id === run.id));
  assert.equal(JSON.stringify(backup).includes(base.password), false);
  const restored = await call("/api/restore", { document: backup });
  assert.notEqual(restored.id, project.id);
  assertPassed(restored.runs.find((item) => item.id === run.id));
  const assertDenied = async (id, planId) => {
    const before = hits;
    const deniedRun = await call(route(id, "run"), { planId });
    assert.equal(deniedRun.status, "failed");
    assert.match(deniedRun.results[0].error, /失效|未授权/);
    assert.equal(
      hits,
      before,
      "unauthorized database task must not reach HTTP",
    );
  };
  await assertDenied(restored.id, restored.plans[0].id);
  await closeApp();
  app = await createApp({ root, port: 0 });
  assert.deepEqual(await call(route(project.id, "database-connections")), []);
  assert.deepEqual(await call(route(restored.id, "database-connections")), []);
  const reloaded = await call(route(project.id, "export"));
  assertPassed(reloaded.runs.find((item) => item.id === run.id));
  await assertDenied(project.id, plan.id);
  await assertDenied(restored.id, restored.plans[0].id);
  const restoredConnection = await grant(restored.id);
  const restoredPlan = await call(route(restored.id, "plans"), {
    id: restored.plans[0].id,
    steps: [{ request: request(restoredConnection.id) }],
  });
  assertPassed(
    await call(route(restored.id, "run"), { planId: restoredPlan.id }),
  );
  await assertDenied(project.id, plan.id);
  // A real read-only query failure rolls back earlier extraction in the same
  // before phase, retaining both initial variables and preventing HTTP entirely.
  for (const [key, value] of Object.entries({
    exact: "initial-exact",
    guard: "initial-guard",
  })) {
    await call(route(restored.id, "environments"), {
      operation: "upsert_global_variable",
      arguments: { key, value },
    });
  }
  const badRequest = request(restoredConnection.id);
  badRequest.before.push({
    type: "database",
    connectionId: restoredConnection.id,
    sql: "SELECT localapi_decimal_missing_function_fixture() AS exact",
    parameters: [],
    name: "guard",
    path: "$.rows[0].exact",
  });
  const badPlan = await call(route(restored.id, "plans"), {
    name: "Real query error preserves initial variables",
    steps: [{ request: badRequest }],
  });
  const beforeError = hits;
  const failed = await call(route(restored.id, "run"), { planId: badPlan.id });
  assert.equal(failed.status, "failed", JSON.stringify(failed));
  assert.match(failed.results[0].error, /ClickHouse查询失败/);
  assert.equal(failed.initialVariables.exact, "initial-exact");
  assert.equal(failed.initialVariables.guard, "initial-guard");
  assert.equal(failed.variables.exact, "initial-exact");
  assert.equal(failed.variables.guard, "initial-guard");
  assert.equal(hits, beforeError, "failed before query must not reach HTTP");
  const unchanged = await call(route(restored.id, "export"));
  assert.equal(unchanged.globalVariables.exact, "initial-exact");
  assert.equal(unchanged.globalVariables.guard, "initial-guard");
  // Explicit revocation is distinct from restore/restart invalidation.
  const revoked = await call(
    route(restored.id, "database-connections"),
    {
      id: restoredConnection.id,
    },
    "DELETE",
  );
  assert.equal(revoked.revoked, true);
  assert.deepEqual(await call(route(restored.id, "database-connections")), []);
  await assertDenied(restored.id, restoredPlan.id);
  console.log("REAL_CLICKHOUSE_DECIMAL_QUERY_ERROR_REVOKE_PASS");
  console.log("REAL_CLICKHOUSE_DECIMAL_PROJECT_ROUNDTRIP_PASS");
} finally {
  await closeApp();
  echo.closeAllConnections();
  await new Promise((resolve) => echo.close(resolve));
  await rm(root, { recursive: true, force: true });
}
console.log("REAL_CLICKHOUSE_FIXTURE_PASS");
