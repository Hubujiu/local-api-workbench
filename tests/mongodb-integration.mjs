import assert from "node:assert/strict";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
const run = (query) =>
  queryRemoteDatabase({
    type: "mongodb",
    host: "127.0.0.1",
    port: 27017,
    database: "fixture",
    query,
  });
const result = await run({
  collection: "items",
  filter: { n: { $gte: 1 } },
  sort: { n: 1 },
  projection: { _id: 0, n: 1, name: 1 },
  limit: 2,
});
assert.equal(result.rows.length, 2);
assert.equal(result.truncated, true);
assert.equal(result.format, "extended-json");
assert.deepEqual(
  result.rows.map((row) => row.n),
  [{ $numberInt: "1" }, { $numberInt: "2" }],
);
assert.equal(result.rows[1].name, "two");
const selected = await run({
  collection: "items",
  filter: { n: { $numberInt: "2" } },
  projection: { _id: 0, name: 1 },
});
assert.deepEqual(selected.rows, [{ name: "two" }]);
await assert.rejects(
  run({ collection: "items", filter: { $where: "db.items.deleteMany({})" } }),
  /禁止/,
);
assert.equal((await run({ collection: "items" })).rows.length, 3);
console.log("REAL_MONGODB_FIXTURES_PASS");

const { verifyNativeMongoFlow } = await import(
  "./native-mongodb-integration.mjs"
);
await verifyNativeMongoFlow({
  type: "mongodb",
  host: "127.0.0.1",
  port: 27017,
  database: "fixture",
});
assert.equal((await run({ collection: "items" })).rows.length, 3);

const { verifyMCPDatabaseFlow } = await import(
  "./mcp-database-integration.mjs"
);
const { nativeMongoFixture } = await import("./fixtures/apipost-mongodb.mjs");
await verifyMCPDatabaseFlow(
  { type: "mongodb", host: "127.0.0.1", port: 27017, database: "fixture" },
  { nativeImport: true, sourceFactory: nativeMongoFixture },
);
console.log("REAL_DECLARED_MONGODB_MCP_SDK_SCOPE_RESTART_PASS");

const { verifyNativeDatabaseCLIFlow } = await import(
  "./native-redis-cli-integration.mjs"
);
await verifyNativeDatabaseCLIFlow(
  { type: "mongodb", host: "127.0.0.1", port: 27017, database: "fixture" },
  { sourceFactory: nativeMongoFixture, expectedValue: "one" },
);
assert.equal((await run({ collection: "items" })).rows.length, 3);
