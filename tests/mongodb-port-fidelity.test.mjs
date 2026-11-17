import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { BSON } from "mongodb";
import { mongoConnection, queryMongo } from "../src/mongodb.mjs";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";

const base = {
  type: "mongodb",
  host: "127.0.0.1",
  database: "fixture",
  query: { collection: "items", limit: 1 },
};
const invalidPorts = [
  null,
  false,
  true,
  {},
  [],
  [27017],
  NaN,
  Infinity,
  -Infinity,
  -1,
  0.5,
  65536,
  Number.MAX_SAFE_INTEGER + 1,
  "not-a-port",
  " ",
  " 27017",
  "27017 ",
  "27017.0",
  "2.7017e4",
  "0x6989",
  "+27017",
  "-0",
  "1_000",
  "27017\n",
];

test("MongoDB rejects ambiguous ports before worker or network construction", async (t) => {
  let attempts = 0;
  const trap = () => {
    attempts++;
    throw Error("unexpected resource");
  };
  t.mock.method(
    workerThreads,
    "Worker",
    class {
      constructor() {
        trap();
      }
    },
  );
  t.mock.method(net.Socket.prototype, "connect", trap);
  t.mock.method(tls, "connect", trap);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (const port of invalidPorts)
    for (const ssl of [false, true]) {
      const input = { ...base, port, ssl };
      const sanitized = (e) => {
        assert.equal(e.message, "MongoDB主机/端口无效");
        return true;
      };
      assert.throws(() => mongoConnection(input), sanitized);
      await assert.rejects(queryMongo(input), sanitized);
      await assert.rejects(queryRemoteDatabase(input), sanitized);
    }
  assert.equal(attempts, 0);
});

test("MongoDB direct port defaults and integer decimal compatibility are explicit", () => {
  for (const port of [undefined, 0, -0, "", "0", "000"])
    assert.equal(
      mongoConnection({ ...base, port }).uri,
      "mongodb://127.0.0.1:27017",
    );
  for (const port of [1, 65535, 27017, "1", "65535", "27017", "00027017"])
    assert.equal(
      mongoConnection({ ...base, port }).uri,
      `mongodb://127.0.0.1:${Number(port)}`,
    );
});

test("MongoDB UI invalid text cannot become a default-port query after JSON serialization", () => {
  for (const text of ["abc", "Infinity", "-Infinity"]) {
    const payload = JSON.parse(JSON.stringify({ ...base, port: Number(text) }));
    assert.equal(payload.port, null);
    assert.throws(() => mongoConnection(payload), /MongoDB主机\/端口无效/);
  }
  // The backend cannot recover spelling already converted to a legal number.
  // UI raw-text validation is separate; preserve existing legal number semantics.
  for (const text of ["0x6989", "2.7017e4", "+27017", "27017.0"])
    assert.equal(
      mongoConnection({ ...base, port: Number(text) }).uri,
      "mongodb://127.0.0.1:27017",
    );
});

test("MongoDB sessions retain integer-only ports and SSH remains unsupported", async (t) => {
  const sessions = new DatabaseSessions();
  t.after(() => sessions.close());
  for (const port of [
    null,
    false,
    true,
    {},
    [],
    "",
    "0",
    "27017",
    "00027017",
    1.5,
    65536,
  ])
    assert.throws(
      () => sessions.register("p", { ...base, name: "fixture", port }),
      /数据库端口无效/,
    );
  assert.deepEqual(sessions.list("p"), []);
  for (const port of [undefined, 0, 1, 65535]) {
    const grant = sessions.register("p", { ...base, name: "fixture", port });
    assert.ok(grant.id);
    sessions.revoke("p", grant.id);
  }
  for (const ssh of [{}, null, false]) {
    assert.throws(
      () => sessions.register("p", { ...base, name: "fixture", ssh }),
      /SSH/,
    );
    await assert.rejects(queryRemoteDatabase({ ...base, ssh }), /SSH/);
  }
  assert.deepEqual(sessions.list("p"), []);
});

// Actual MongoClient wire traffic against a bounded protocol fixture, not a
// real MongoDB service, authentication test or write endpoint.
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
test("MongoDB actual driver reaches exactly the decimal-port fixture through direct and remote queries", async (t) => {
  const f = await fixture(t);
  for (const port of [f.port, String(f.port), "000" + f.port])
    for (const query of [queryMongo, queryRemoteDatabase]) {
      const result = await query({ ...base, port });
      assert.deepEqual(result.rows, [{ value: "fixture" }]);
      const command = f.seen.filter((x) => x.find).at(-1);
      assert.equal(command.$db, "fixture");
      assert.equal(command.find, "items");
    }
  assert.equal(f.seen.filter((x) => x.find).length, 6);
});
