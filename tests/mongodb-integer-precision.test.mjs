import test from "node:test";
import assert from "node:assert/strict";
import { BSON } from "mongodb";
import { mongoQuery, queryMongo } from "../src/mongodb.mjs";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";

const unsafeSQL = '{"collection":"items","filter":{"id":9007199254740993}}';
const precisionError =
  /MongoDB.*安全精度.*\$numberLong.*\$numberDecimal.*\$numberDouble/;

test("pure BSON baseline: naked JSON integer changes target before deserialization", () => {
  const parsed = JSON.parse(unsafeSQL);
  assert.equal(String(parsed.filter.id), "9007199254740992");
  assert.deepEqual(
    BSON.EJSON.serialize(
      BSON.EJSON.deserialize(parsed.filter, { relaxed: false }),
      { relaxed: false },
    ),
    { id: { $numberLong: "9007199254740992" } },
  );
  const explicit = { id: { $numberLong: "9007199254740993" } };
  assert.deepEqual(
    BSON.EJSON.serialize(BSON.EJSON.deserialize(explicit, { relaxed: false }), {
      relaxed: false,
    }),
    explicit,
  );
});

test("Mongo query recursively rejects bare unsafe integers in string and object input", () => {
  assert.throws(() => mongoQuery({ sql: unsafeSQL }), precisionError);
  for (const value of [9007199254740992, -9007199254740992, 1e30]) {
    for (const filter of [
      { id: value },
      { $and: [{ id: { $in: [1, value] } }] },
      { nested: { values: [[value]] } },
    ]) {
      const query = { collection: "items", filter };
      const original = structuredClone(query);
      assert.throws(() => mongoQuery({ query }), precisionError);
      assert.throws(
        () => mongoQuery({ sql: JSON.stringify(query) }),
        precisionError,
      );
      assert.deepEqual(query, original);
    }
  }
});

test("safe integers, finite fractions and explicit BSON numeric intent remain unchanged", () => {
  for (const value of [
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    0,
    -0,
    0.1,
    -1.25,
    Number.MIN_VALUE,
    { $numberLong: "9007199254740993" },
    { $numberDecimal: "9007199254740993.125" },
    { $numberDouble: "9007199254740993" },
  ]) {
    const query = { collection: "items", filter: { id: value } };
    assert.deepEqual(mongoQuery({ query }).filter, query.filter);
  }
  const value = BSON.EJSON.deserialize(
    { id: { $numberDouble: "9007199254740993" } },
    { relaxed: false },
  );
  assert.equal(value.id._bsontype, "Double");
  assert.equal(value.id.value, 9007199254740992);
  for (const value of [Infinity, -Infinity, NaN])
    assert.throws(
      () =>
        mongoQuery({ query: { collection: "items", filter: { id: value } } }),
      /数值无效/,
    );
});

test("direct adapter and temporary-grant entry reject before connection access or network worker", async () => {
  for (const adapter of [queryMongo, queryRemoteDatabase]) {
    let connectionReads = 0;
    const input = {
      type: "mongodb",
      sql: unsafeSQL,
      get host() {
        connectionReads++;
        throw Error("connection must not be read");
      },
    };
    await assert.rejects(adapter(input), precisionError);
    assert.equal(connectionReads, 0);
    await assert.rejects(
      adapter({
        type: "mongodb",
        host: "invalid/host",
        query: JSON.parse(unsafeSQL),
      }),
      precisionError,
    );
  }
  const sessions = new DatabaseSessions();
  const grant = sessions.register("source", {
    type: "mongodb",
    name: "not contacted",
    host: "invalid/host",
    database: "fixture",
  });
  await assert.rejects(
    sessions.query("source", {
      connectionId: grant.id,
      sql: unsafeSQL,
      parameters: [],
    }),
    precisionError,
  );
  assert.deepEqual(sessions.list("source"), [grant]);
  await assert.rejects(
    sessions.query("other", {
      connectionId: grant.id,
      sql: unsafeSQL,
      parameters: [],
    }),
    /未授权/,
  );
  assert.deepEqual(sessions.list("other"), []);
  sessions.close();
});
