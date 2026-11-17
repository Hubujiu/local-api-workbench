import test from "node:test";
import assert from "node:assert/strict";
import { mongoQuery, mongoConnection, queryMongo } from "../src/mongodb.mjs";

test("MongoDB accepts only bounded find/filter/projection/sort specifications", () => {
  const q = mongoQuery({
    sql: JSON.stringify({
      collection: "items",
      filter: { n: { $gte: 2 } },
      projection: { _id: 0, n: 1 },
      sort: { n: -1 },
      limit: 5,
      skip: 1,
    }),
  });
  assert.equal(q.collection, "items");
  assert.equal(q.limit, 5);
  assert.equal(q.skip, 1);
  assert.deepEqual(q.filter, { n: { $gte: 2 } });
  for (const query of [
    { collection: "items", command: "drop" },
    { collection: "items", filter: { $where: "return true" } },
    {
      collection: "items",
      filter: { $and: [{ x: { $function: { body: "x" } } }] },
    },
    { collection: "items", filter: [], limit: 5 },
    { collection: "items", projection: { x: { $meta: "textScore" } } },
    { collection: "items", sort: { n: "descending" } },
    { collection: "items", limit: 0 },
    { collection: "items", limit: 1001 },
    { collection: "items", skip: 100001 },
  ])
    assert.throws(() => mongoQuery({ query }), /MongoDB/);
});
test("MongoDB connections are single-host strict TLS with request-scoped credentials", async () => {
  const c = mongoConnection({
    host: "::1",
    port: 27017,
    database: "fixture",
    user: "fixture",
    password: "a:b@secret",
    ssl: true,
    ca: "fixture-ca",
  });
  assert.equal(c.uri, "mongodb://[::1]:27017");
  assert(!c.uri.includes("secret"));
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(c.uri, c.options);
  await client.close();
  assert.equal(c.options.auth.password, "a:b@secret");
  assert.equal(c.options.tls, true);
  assert.equal(c.options.tlsAllowInvalidCertificates, false);
  assert.equal(c.options.directConnection, true);
  assert.equal(c.options.retryReads, false);
  for (const input of [
    { host: "other/?uri=injection", database: "fixture" },
    { database: "bad/name" },
    { database: "fixture", port: -1 },
    { database: "fixture", ssl: "false" },
  ])
    assert.throws(() => mongoConnection(input), /MongoDB/);
});
test("MongoDB rejects prohibited operations before creating a network worker", async () => {
  await assert.rejects(
    queryMongo({
      host: "127.0.0.1",
      database: "fixture",
      query: { collection: "items", filter: { $where: "x" } },
    }),
    /MongoDB/,
  );
});
