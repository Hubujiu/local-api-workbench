import test from "node:test";
import assert from "node:assert/strict";
import { importIntoProject } from "../src/core.mjs";
import { nativeMongoFixture } from "./fixtures/apipost-mongodb.mjs";
import {
  databaseAssignments,
  normalizeDatabaseOperations,
} from "../src/script-database-tasks.mjs";
import { assertDatabaseBindingRequirements } from "../src/database-sessions.mjs";
import { runNativeTaskPhase } from "../src/native-task-phase.mjs";
const project = () => ({ requests: [], environments: [], settings: {} });
test("declared native findone becomes a bounded readonly Mongo query and retains no source connection details", () => {
  const source = nativeMongoFixture("http://127.0.0.1:1/"),
    before = structuredClone(source),
    p = project();
  importIntoProject(p, source);
  assert.equal(p.settings.apipostDatabases[0].type, "mongodb");
  for (const value of [
    "source-auth-not-inherited",
    "discard-this-fictional-password",
    "private-host.invalid",
  ])
    assert(!JSON.stringify(p).includes(value));
  const operation = p.requests[0].nativeTasks.before.find(
    (t) => t.type === "database",
  ).data;
  assert.equal(operation.resultShape, "mongodb-document");
  assert.deepEqual(JSON.parse(operation.query), {
    collection: "items",
    filter: { name: "one" },
    projection: {},
    sort: {},
    limit: 1,
    skip: 0,
  });
  assert.deepEqual(
    databaseAssignments(operation, {
      format: "extended-json",
      rows: [{ name: "one" }],
      truncated: true,
    }),
    [{ name: "native_value", type: "environment", value: "one" }],
  );
  assert.deepEqual(
    databaseAssignments(operation, { format: "extended-json", rows: [] }),
    [{ name: "native_value", type: "environment", value: null }],
  );
  assert.throws(
    () =>
      databaseAssignments(operation, { format: "extended-json", rows: [{}] }),
    /不存在/,
  );
  assert.throws(
    () => databaseAssignments(operation, { rows: [{ name: "one" }] }),
    /Extended/,
  );
  assert.deepEqual(source, before);
});
test("Mongo task conversion rejects executable commands, forged shapes and ambiguous inputs atomically", () => {
  for (const change of [
    (d) => (d.method = "findOne"),
    (d) => (d.method = "deleteMany"),
    (d) => (d.query = '[{"name":"one"}]'),
    (d) => (d.query = "db.items.findOne({})"),
    (d) => (d.query = '{"$where":"1"}'),
    (d) => (d.query = '{"name":"{{dynamic}}"}'),
    (d) => (d.collectionName = ""),
    (d) => (d.resultShape = "mongodb-document"),
    (d) => (d.unknown = true),
  ]) {
    const source = nativeMongoFixture("http://127.0.0.1:1/");
    change(source.apis[1].request.pre_tasks[1].data);
    const p = project(),
      before = structuredClone(p);
    assert.throws(() => importIntoProject(p, source));
    assert.deepEqual(p, before);
  }
  const operation = {
    connectionId: "c",
    resultShape: "mongodb-document",
    query: JSON.stringify({ collection: "items", filter: {}, limit: 2 }),
    variables: [],
    isConsoleOutput: -1,
  };
  assert.throws(() => normalizeDatabaseOperations([operation]), /单文档/);
  assert.throws(
    () =>
      assertDatabaseBindingRequirements(
        { type: "mongodb" },
        { type: "mongodb", user: "fixture" },
      ),
    /authSource/,
  );
});
test("Mongo document fields preserve Extended JSON while null assigns null without path traversal", () => {
  const operation = {
    resultShape: "mongodb-document",
    variables: [
      { name: "n", type: "environment", pattern: "$.n" },
      { name: "id", type: "temporary", pattern: "$._id" },
    ],
  };
  const value = {
    n: { $numberLong: "9007199254740993" },
    _id: { $oid: "000000000000000000000001" },
  };
  assert.deepEqual(
    databaseAssignments(operation, { format: "extended-json", rows: [value] }),
    [
      { name: "n", type: "environment", value: value.n },
      { name: "id", type: "temporary", value: value._id },
    ],
  );
  assert(
    databaseAssignments(operation, { format: "extended-json", rows: [] }).every(
      (entry) => entry.value === null,
    ),
  );
});
test("enabled database console output does not silently omit falsey scalar and empty-document results", async () => {
  for (const value of [0, null, ""]) {
    const result = await runNativeTaskPhase(
      [
        {
          type: "database",
          enabled: 1,
          data: {
            connectionId: "c",
            query: '["GET","k"]',
            resultShape: "redis-value",
            variables: [],
            isConsoleOutput: 1,
          },
        },
      ],
      { variables: {} },
      { databaseQuery: async () => ({ rows: [{ value }] }) },
    );
    assert(
      result.logs.includes(JSON.stringify(value)),
      JSON.stringify(result.logs),
    );
  }
  const result = await runNativeTaskPhase(
    [
      {
        type: "database",
        enabled: 1,
        data: {
          connectionId: "c",
          query: '{"collection":"items","limit":1}',
          resultShape: "mongodb-document",
          variables: [],
          isConsoleOutput: 1,
        },
      },
    ],
    { variables: {} },
    { databaseQuery: async () => ({ format: "extended-json", rows: [] }) },
  );
  assert(result.logs.includes("null"), JSON.stringify(result.logs));
});
