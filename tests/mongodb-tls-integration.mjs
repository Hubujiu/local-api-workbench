// Actual authenticated MongoDB over verified TLS, isolated CI container only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MongoClient } from "mongodb";
import { mongoConnection } from "../src/mongodb.mjs";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import { verifyNativeMongoFlow } from "./native-mongodb-integration.mjs";
const ca = await readFile(
  new URL("./fixtures/localhost.crt", import.meta.url),
  "utf8",
);
const mongoTLSConfig = {
  type: "mongodb",
  host: "127.0.0.1",
  port: 27018,
  database: "fixture",
  user: "readonly-fixture",
  password: "public-ci-fixture-only",
  authSource: "fixture",
  ssl: true,
  ca,
};
const query = {
  collection: "items",
  filter: { name: "one" },
  projection: { _id: 0, name: 1 },
  limit: 1,
};
const result = await queryRemoteDatabase({ ...mongoTLSConfig, query });
assert.deepEqual(result.rows, [{ name: "one" }]);
for (const [patch, pattern] of [
  [{ ca: undefined }, /certificate|self.signed/i],
  [{ password: "incorrect-public-fixture" }, /auth|认证/i],
  [{ authSource: "admin" }, /auth|认证/i],
  [{ user: undefined, password: undefined }, /auth|requires|认证/i],
])
  await assert.rejects(
    queryRemoteDatabase({ ...mongoTLSConfig, ...patch, query }),
    pattern,
  );
const connection = mongoConnection(mongoTLSConfig);
const client = new MongoClient(connection.uri, connection.options);
try {
  await client.connect();
  await assert.rejects(
    client.db("fixture").collection("items").insertOne({ forbidden: true }),
    /not authorized|unauthorized/i,
  );
} finally {
  await client.close();
}
await verifyNativeMongoFlow(mongoTLSConfig);
assert.deepEqual(
  (await queryRemoteDatabase({ ...mongoTLSConfig, query })).rows,
  [{ name: "one" }],
);
console.log("REAL_MONGODB_TLS_READONLY_AUTH_HTTP_RESTORE_PASS");
