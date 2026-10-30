import test from "node:test";
import assert from "node:assert/strict";
import {
  importIntoProject,
  normalizeRequest,
  snapshotPlan,
  runPlan,
} from "../src/core.mjs";
import { nativeRedisFixture } from "./fixtures/apipost-redis.mjs";
import {
  databaseAssignments,
  normalizeDatabaseOperations,
} from "../src/script-database-tasks.mjs";
const project = () => ({ requests: [], environments: [], settings: {} });
test("native Redis JSON-object queries become explicit readonly commands without retaining credentials", () => {
  for (const [method, query, command] of [
    ["get", '{"key":"k"}', ["GET", "k"]],
    ["hget", '{"key":"h","field":"f"}', ["HGET", "h", "f"]],
    ["exists", '{"key":"k"}', ["EXISTS", "k"]],
  ]) {
    const source = nativeRedisFixture("http://127.0.0.1:1/", { method, query }),
      before = structuredClone(source),
      p = project();
    importIntoProject(p, source);
    assert.equal(p.settings.apipostDatabases[0].type, "redis");
    assert(!JSON.stringify(p).includes("discard-this-fictional-password"));
    const operation = p.requests[0].nativeTasks.before.find(
      (t) => t.type === "database",
    ).data;
    assert.equal(operation.resultShape, "redis-value");
    assert.deepEqual(JSON.parse(operation.query), command);
    assert.equal(operation.variables[0].pattern, "$");
    assert.deepEqual(
      normalizeRequest(p.requests[0]).nativeTasks,
      p.requests[0].nativeTasks,
    );
    assert.deepEqual(source, before);
    for (const value of ["hello", "", null, 0, 1, '{"literal":true}', "123"])
      assert.deepEqual(databaseAssignments(operation, { rows: [{ value }] }), [
        { name: "native_value", type: "environment", value },
      ]);
  }
});
test("unsupported Redis methods, command injection, malformed parameters and forged source shape reject atomically", () => {
  for (const change of [
    (d) => (d.method = "set"),
    (d) => (d.method = "GET"),
    (d) => (d.query = '["GET","k"]'),
    (d) => (d.query = '{"key":"k","password":"secret"}'),
    (d) => (d.query = '{"key":1}'),
    (d) => (d.query = '{"key":"{{dynamic}}"}'),
    (d) => (d.resultShape = "redis-value"),
    (d) => (d.query = '{"key":"k","field":"f"}'),
  ]) {
    const source = nativeRedisFixture("http://127.0.0.1:1/");
    change(
      source.apis[1].request.pre_tasks.find((t) => t.type === "database").data,
    );
    const p = project(),
      before = structuredClone(p);
    assert.throws(() => importIntoProject(p, source));
    assert.deepEqual(p, before);
  }
  for (const command of [
    ["SET", "k", "v"],
    ["EXISTS", "a", "b"],
    ["SCAN", "0"],
  ])
    assert.throws(() =>
      normalizeDatabaseOperations([
        {
          connectionId: "c",
          query: JSON.stringify(command),
          resultShape: "redis-value",
          variables: [],
          isConsoleOutput: -1,
        },
      ]),
    );
});
test("Redis scalar task pipelines preserve scope and HTTP preparation without parsing JSON-looking values", async () => {
  const p = project();
  importIntoProject(p, nativeRedisFixture("http://127.0.0.1:1/"));
  let queries = 0,
    requests = 0;
  const result = await runPlan(
    snapshotPlan({ steps: [{ request: p.requests[0] }] }),
    {},
    async (request) => {
      requests++;
      assert(
        request.headers.some(
          (h) => h.key === "x-db-value" && h.value.includes('{"literal":true}'),
        ),
      );
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          value: request.headers.find((h) => h.key === "x-db-value").value,
        }),
        duration: 1,
      };
    },
    {
      databaseQuery: async (op) => {
        queries++;
        assert.deepEqual(JSON.parse(op.sql), ["GET", "localapi:fixture"]);
        return { rows: [{ value: '{"literal":true}' }] };
      },
    },
  );
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(queries, 1);
  assert.equal(requests, 1);
});

test("native Redis scalar extraction never indexes a string through retained path metadata", () => {
  for (const pattern of ["$", "$[0]", "$.length", "$.missing"]) {
    const operation = {
      resultShape: "redis-value",
      variables: [{ name: "v", type: "environment", pattern }],
    };
    for (const value of ["hello", "", null, 0, 1, '{"literal":true}'])
      assert.deepEqual(databaseAssignments(operation, { rows: [{ value }] }), [
        { name: "v", type: "environment", value },
      ]);
  }
});

test("native SET imports inert intent and every ordinary runPlan entrypoint denies before effects", async () => {
  const p = project();
  importIntoProject(
    p,
    nativeRedisFixture("http://127.0.0.1:1/", {
      method: "set",
      query: '{"key":"k","value":"v"}',
    }),
  );
  const operation = p.requests[0].nativeTasks.before.find(
    (task) => task.type === "database",
  ).data;
  assert.equal(operation.writeIntent, "redis-set");
  assert.equal(operation.query, '["SET","k","v"]');
  assert.deepEqual(
    normalizeRequest(p.requests[0]).nativeTasks,
    p.requests[0].nativeTasks,
  );
  let effects = 0;
  await assert.rejects(
    runPlan(
      snapshotPlan({ steps: [{ request: p.requests[0] }] }),
      {},
      async () => {
        effects++;
      },
      {
        databaseQuery: async () => {
          effects++;
        },
      },
    ),
    { code: "NATIVE_WRITE_AUTHORITY_REQUIRED" },
  );
  assert.equal(effects, 0);
  const forged = nativeRedisFixture("http://127.0.0.1:1/");
  forged.apis[1].request.pre_tasks.find(
    (task) => task.type === "database",
  ).data.writeIntent = "redis-set";
  assert.throws(() => importIntoProject(project(), forged));
});
