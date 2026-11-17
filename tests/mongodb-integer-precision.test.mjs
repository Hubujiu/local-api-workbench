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

test("pure BSON baseline: oversized Long wraps and mixed wrappers discard fields", () => {
  for (const [source, wrapped] of [
    ["9223372036854775808", "-9223372036854775808"],
    ["18446744073709551616", "0"],
    ["-9223372036854775809", "9223372036854775807"],
  ]) {
    assert.equal(
      BSON.EJSON.deserialize(
        { $numberLong: source },
        { relaxed: false },
      ).toString(),
      wrapped,
    );
  }
  for (const extra of [{ extra: 2 }, { $gt: 5 }])
    assert.equal(
      BSON.EJSON.deserialize(
        { $numberLong: "1", ...extra },
        { relaxed: false },
      ).toString(),
      "1",
    );
});

test("Long wrappers reject signed overflow, malformed decimal and ignored sibling fields before connection", async () => {
  const invalid = [
    { $numberLong: "9223372036854775808" },
    { $numberLong: "18446744073709551616" },
    { $numberLong: "-9223372036854775809" },
    { $numberLong: "1", extra: 2 },
    { $numberLong: "1", $gt: 5 },
    ...[
      1,
      null,
      {},
      "",
      "1.0",
      "1e3",
      " 1",
      "1 ",
      "0x10",
      "01",
      "-0",
      "+01",
      "9".repeat(21),
    ].map((value) => ({ $numberLong: value })),
  ];
  const sessions = new DatabaseSessions();
  const grant = sessions.register("source", {
    type: "mongodb",
    name: "not contacted",
    host: "invalid/host",
    database: "fixture",
  });
  for (const value of invalid) {
    const query = {
      collection: "items",
      filter: { $and: [{ id: { $in: [value] } }] },
    };
    const original = structuredClone(query);
    for (const input of [{ query }, { sql: JSON.stringify(query) }]) {
      assert.throws(() => mongoQuery(input), /\$numberLong/);
      for (const adapter of [queryMongo, queryRemoteDatabase])
        await assert.rejects(
          adapter({
            ...input,
            type: "mongodb",
            get host() {
              throw Error("connection must not be read");
            },
          }),
          /\$numberLong/,
        );
    }
    await assert.rejects(
      sessions.query("source", {
        connectionId: grant.id,
        sql: JSON.stringify(query),
        parameters: [],
      }),
      /\$numberLong/,
    );
    assert.deepEqual(query, original);
  }
  assert.deepEqual(sessions.list("source"), [grant]);
  sessions.close();
});

test("signed Long boundaries and explicit plus keep numerical, not lexical, identity", () => {
  for (const text of [
    "-9223372036854775808",
    "9223372036854775807",
    "+9223372036854775807",
    "0",
    "+0",
    "1",
    "+1",
    "-1",
  ]) {
    const filter = { id: { $numberLong: text } };
    for (const input of [
      { query: { collection: "items", filter } },
      { sql: JSON.stringify({ collection: "items", filter }) },
    ]) {
      assert.deepEqual(mongoQuery(input).filter, filter);
      const decoded = BSON.EJSON.deserialize(mongoQuery(input).filter, {
        relaxed: false,
      });
      assert.equal(decoded.id.toString(), BigInt(text).toString());
    }
  }
});

test("numeric wrapper baseline and singleton shape prevent ignored filter conditions", async () => {
  for (const [key, text] of [
    ["$numberInt", "1"],
    ["$numberLong", "1"],
    ["$numberDouble", "1.5"],
    ["$numberDecimal", "1.5"],
  ]) {
    const wrapper = { [key]: text };
    for (const extra of [
      { extra: 2 },
      { $gt: 5 },
      { $numberInt: "2", $numberLong: "2" },
    ]) {
      const mixed = { ...wrapper, ...extra };
      if (!Object.hasOwn(extra, "$numberInt"))
        assert.deepEqual(
          BSON.EJSON.serialize(
            BSON.EJSON.deserialize(mixed, { relaxed: false }),
            { relaxed: false },
          ),
          BSON.EJSON.serialize(
            BSON.EJSON.deserialize(wrapper, { relaxed: false }),
            { relaxed: false },
          ),
        );
      for (const value of [
        mixed,
        { [key]: 1 },
        { [key]: null },
        { [key]: {} },
        { [key]: [] },
      ]) {
        const query = { collection: "items", filter: { id: { $in: [value] } } };
        for (const input of [{ query }, { sql: JSON.stringify(query) }]) {
          assert.throws(() => mongoQuery(input), /MongoDB \$number/);
          await assert.rejects(
            queryRemoteDatabase({
              ...input,
              type: "mongodb",
              get host() {
                throw Error("connection must not be read");
              },
            }),
            /MongoDB \$number/,
          );
        }
      }
    }
  }
});

test("Int32 overflow baseline is rejected, decimal integer spelling retains numeric semantics", () => {
  for (const [text, wrapped] of [
    ["2147483648", -2147483648],
    ["-2147483649", 2147483647],
    ["4294967296", 0],
  ]) {
    assert.equal(
      BSON.EJSON.deserialize({ $numberInt: text }, { relaxed: false }).value,
      wrapped,
    );
  }
  for (const text of [
    "2147483648",
    "-2147483649",
    "4294967296",
    "+0002147483648",
    "1e2",
    "0x10",
    "1.2",
    "",
    " ",
    " 1",
    "1 ",
    "NaN",
    "Infinity",
  ]) {
    const query = { collection: "items", filter: { id: { $numberInt: text } } };
    assert.throws(() => mongoQuery({ query }), /\$numberInt/);
    assert.throws(
      () => mongoQuery({ sql: JSON.stringify(query) }),
      /\$numberInt/,
    );
  }
  for (const text of [
    "-2147483648",
    "2147483647",
    "+2147483647",
    "0",
    "+0",
    "-0",
    "0001",
    "-0001",
    "+0000",
  ]) {
    const query = { collection: "items", filter: { id: { $numberInt: text } } };
    assert.deepEqual(mongoQuery({ query }).filter, query.filter);
    assert.equal(
      BigInt(BSON.EJSON.deserialize(query.filter, { relaxed: false }).id.value),
      BigInt(text),
    );
  }
});

test("explicit Double and Decimal128 valid semantics remain delegated to BSON", () => {
  for (const key of ["$numberDouble", "$numberDecimal"])
    for (const text of [
      "1.5",
      "NaN",
      "Infinity",
      "-Infinity",
      "9007199254740993",
      "-0",
      "1E+3",
    ]) {
      const filter = { id: { [key]: text } };
      const query = { collection: "items", filter };
      for (const input of [{ query }, { sql: JSON.stringify(query) }]) {
        const checked = mongoQuery(input).filter;
        assert.deepEqual(checked, filter);
        assert.deepEqual(
          BSON.EJSON.serialize(
            BSON.EJSON.deserialize(checked, { relaxed: false }),
            { relaxed: false },
          ),
          BSON.EJSON.serialize(
            BSON.EJSON.deserialize(filter, { relaxed: false }),
            { relaxed: false },
          ),
        );
      }
    }
});
