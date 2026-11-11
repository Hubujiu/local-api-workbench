import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { BSON } from "mongodb";
import { mongoQuery, mongoConnection, queryMongo } from "../src/mongodb.mjs";
import { normalizeDatabaseOperations } from "../src/script-database-tasks.mjs";
const badQueries = [
  { collection: "\ud800" },
  { collection: "items", filter: { name: "\udfff" } },
  {
    collection: "items",
    filter: { $and: [{ name: { $in: ["valid", "\ud800"] } }] },
  },
  { collection: "items", filter: { "\ud800": 1, "�": 2 } },
  { collection: "items", filter: { nested: { "\udfff": 1 } } },
  { collection: "items", projection: { "\ud800": 1 } },
  { collection: "items", sort: { "\udfff": -1 } },
];
test("Mongo find rejects malformed Unicode keys and values before canonicalization", () => {
  for (const query of badQueries) {
    assert.throws(() => mongoQuery({ query }), /MongoDB/);
    assert.throws(() => mongoQuery({ sql: JSON.stringify(query) }), /MongoDB/);
    assert.throws(
      () =>
        normalizeDatabaseOperations([
          {
            connectionId: "bound",
            query: JSON.stringify({ ...query, limit: 1 }),
            resultShape: "mongodb-document",
            isConsoleOutput: 0,
            variables: [],
          },
        ]),
      /MongoDB/,
    );
  }
});
test("Mongo database, selected authSource and credentials reject malformed Unicode without echoing inputs", () => {
  for (const key of ["database", "authSource", "user", "password"])
    for (const value of ["private-\ud800", "private-\udfff"]) {
      assert.throws(
        () =>
          mongoConnection({
            database: "fixture",
            user: "fixture",
            [key]: value,
          }),
        (e) =>
          e.message ===
          (["database", "authSource"].includes(key)
            ? "MongoDB数据库/认证库名称无效"
            : "MongoDB认证参数无效"),
      );
    }
});
test("invalid Mongo names and queries cannot construct a worker or connect", async () => {
  const OriginalWorker = workerThreads.Worker;
  let workers = 0;
  workerThreads.Worker = class {
    constructor() {
      workers++;
      throw Error("worker must not start");
    }
  };
  syncBuiltinESMExports();
  try {
    for (const query of badQueries)
      await assert.rejects(
        queryMongo({ host: "127.0.0.1", database: "fixture", query }),
        /MongoDB/,
      );
    for (const field of ["database", "authSource", "user", "password"])
      await assert.rejects(
        queryMongo({
          host: "127.0.0.1",
          database: "fixture",
          user: "fixture",
          [field]: "\ud800",
          query: { collection: "items" },
        }),
        /MongoDB/,
      );
    assert.equal(workers, 0);
  } finally {
    workerThreads.Worker = OriginalWorker;
    syncBuiltinESMExports();
  }
});
test("valid Unicode retains recursive shape, numeric policy and structural limits", () => {
  for (const text of ["中文🙂�", "", "\0"]) {
    const connection = mongoConnection({
      database: "fixture",
      user: "fixture",
      password: text,
    });
    assert.equal(connection.options.auth.password, text);
  }
  const user = "用户🙂�";
  assert.equal(
    mongoConnection({ database: "fixture", user, password: "" }).options.auth
      .username,
    user,
  );
  assert.equal(
    mongoConnection({ database: "fixture" }).options.auth,
    undefined,
  );
  const source = {
    collection: "中文🙂�",
    filter: {
      "字段🙂": { $in: ["中文🙂", "�", "\u0000"] },
      nested: [{ value: "valid" }],
    },
    projection: { "字段🙂": 1 },
    sort: { "字段�": -1 },
  };
  const value = mongoQuery({ query: source });
  assert.deepEqual(value.filter, source.filter);
  assert.equal(value.collection, source.collection);
  assert.equal(
    mongoConnection({
      database: "中文🙂�",
      user: "fixture",
      authSource: "认证🙂�",
    }).options.authSource,
    "认证🙂�",
  );
  let deep = "valid";
  for (let i = 0; i < 12; i++) deep = { value: deep };
  assert.throws(
    () => mongoQuery({ query: { collection: "items", filter: deep } }),
    /过深/,
  );
  assert.throws(
    () =>
      mongoQuery({
        query: {
          collection: "items",
          filter: { x: { $in: Array(1001).fill("valid") } },
        },
      }),
    /过大/,
  );
  assert.throws(
    () =>
      mongoQuery({
        query: { collection: "items", filter: { x: 9007199254740992 } },
      }),
    /安全精度/,
  );
});
// Bounded protocol fixture, not a real MongoDB service. Actual MongoClient
// handshakes and sends OP_MSG; assertions inspect its BSON network bytes.
async function fixture(t) {
  const seen = [],
    sockets = new Set();
  let sequence = 1;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= pending.readInt32LE(0)) {
        const size = pending.readInt32LE(0);
        assert(size >= 21 && size < 1024 * 1024);
        const frame = pending.subarray(0, size);
        pending = pending.subarray(size);
        const opcode = frame.readInt32LE(12);
        assert([2004, 2013].includes(opcode));
        const offset = opcode === 2004 ? frame.indexOf(0, 20) + 9 : 21;
        const request = BSON.deserialize(frame.subarray(offset));
        seen.push(request);
        const response = request.find
          ? {
              ok: 1,
              cursor: {
                id: BSON.Long.ZERO,
                ns: `${request.$db}.${request.find}`,
                firstBatch: [{ value: "fixture" }],
              },
            }
          : {
              ok: 1,
              isWritablePrimary: true,
              ismaster: true,
              minWireVersion: 0,
              maxWireVersion: 17,
            };
        const bytes = BSON.serialize(response);
        let out;
        if (opcode === 2004) {
          out = Buffer.alloc(36 + bytes.length);
          out.writeInt32LE(1, 12);
          out.writeInt32LE(1, 32);
          bytes.copy(out, 36);
        } else {
          out = Buffer.alloc(21 + bytes.length);
          out.writeInt32LE(2013, 12);
          bytes.copy(out, 21);
        }
        out.writeInt32LE(out.length, 0);
        out.writeInt32LE(sequence++, 4);
        out.writeInt32LE(frame.readInt32LE(4), 8);
        socket.write(out);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  return { seen, port: server.address().port };
}
test("valid Unicode collection database filter projection sort reach actual driver wire unchanged", async (t) => {
  const f = await fixture(t);
  const query = {
    collection: "集合🙂�",
    filter: { "字段🙂": { $in: ["中文", "�", "🙂"] } },
    projection: { "字段�": 1 },
    sort: { "字段🙂": -1 },
    limit: 1,
  };
  const result = await queryMongo({
    host: "127.0.0.1",
    port: f.port,
    database: "数据库🙂�",
    query,
  });
  assert.deepEqual(result.rows, [{ value: "fixture" }]);
  const wire = f.seen.find((x) => x.find);
  assert.equal(wire.find, query.collection);
  assert.equal(wire.$db, "数据库🙂�");
  assert.deepEqual(wire.filter, query.filter);
  assert.deepEqual(wire.projection, query.projection);
  assert.deepEqual(wire.sort, query.sort);
});
