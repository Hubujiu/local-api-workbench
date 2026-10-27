// Ordinary adapter event-contract tests. No TDS server, real SQL connection,
// Microsoft image, or wire/TLS/read-only acceptance is exercised here.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { TYPES } from "tedious";
import { createTediousSQLServerPort } from "../src/sqlserver-tedious-wip.mjs";
import { sqlServerConnectionContract } from "../src/sqlserver-read-contract.mjs";
import {
  runSQLServerReadWIP,
  SQLSERVER_READONLY_PROBE,
} from "../src/sqlserver-read-wip.mjs";

const input = {
  connection: {
    host: "fixture.invalid",
    port: 1433,
    user: "fixture",
    password: "",
    database: "fixture",
    ssl: true,
  },
  sql: "SELECT id FROM dbo.items WHERE id=@p0",
  parameters: [{ type: "int64", value: "9223372036854775807" }],
};
const col = (type = "IntN", dataLength = 8, colName = "id") => ({
  type: { name: type },
  dataLength,
  colName,
});
function result(request, columns, values) {
  request.emit("columnMetadata", columns);
  for (const row of values)
    request.emit(
      "row",
      row.map((value, i) => ({ metadata: columns[i], value })),
    );
  request.emit("doneInProc", values.length, true);
  request.emit("doneProc", undefined, false, 0);
  request.callback();
  request.emit("requestCompleted");
}
function fixture(t, behavior = {}) {
  const connections = [],
    requests = [],
    sockets = [],
    targets = [];
  // Actual Node Socket allocation/close, but connect is replaced BEFORE any
  // adapter runs: this test cannot perform DNS or establish a TCP connection.
  t.mock.method(Socket.prototype, "connect", function (options) {
    sockets.push(this);
    targets.push(options);
    queueMicrotask(() => {
      if (!this.destroyed) this.emit("connect");
    });
    return this;
  });
  class C extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this.closes = 0;
      connections.push(this);
    }
    connect(callback) {
      this.connectCallback = callback;
      this.config.options.connector().then(() => {
        if (behavior.connect) return behavior.connect(this, callback);
        this.emit("secure", { authorized: true });
        this.emit("databaseChange", "fixture");
        callback();
      }, callback);
    }
    execSql(request) {
      requests.push(request);
      if (request.sql === SQLSERVER_READONLY_PROBE) {
        result(
          request,
          [col("NVarChar", 120, "updateability")],
          [[behavior.state ?? "READ_ONLY"]],
        );
      } else if (behavior.query) behavior.query(request, this);
      else result(request, [col()], [["9223372036854775807"]]);
    }
    close() {
      this.closes++;
      if (!behavior.holdEnd) queueMicrotask(() => this.emit("end"));
    }
  }
  class R extends EventEmitter {
    constructor(sql, callback) {
      super();
      this.sql = sql;
      this.callback = callback;
      this.parameters = [];
      this.cancels = 0;
    }
    addParameter(...args) {
      this.parameters.push(args);
    }
    setTimeout(ms) {
      this.timeout = ms;
    }
    cancel() {
      this.cancels++;
      this.callback(Error("fixture private error"));
    }
  }
  const factory = (config) =>
    createTediousSQLServerPort(config, { Connection: C, Request: R });
  return { factory, connections, requests, sockets, targets };
}
test("Tedious WIP binds real TYPES, checks same-connection probe, maps nullable int64 and closes owned socket", async (t) => {
  const f = fixture(t);
  const r = await runSQLServerReadWIP(
    {
      ...input,
      connection: { ...input.connection, ca: "contract-only CA bytes" },
    },
    { factory: f.factory },
  );
  assert.equal(r.rows[0].id, "9223372036854775807");
  assert.equal(f.connections.length, 1);
  assert.equal(f.connections[0].closes, 1);
  assert.deepEqual(f.targets, [
    { host: "fixture.invalid", port: 1433, autoSelectFamily: false },
  ]);
  assert.equal(f.sockets[0].destroyed, true);
  assert.equal(f.requests[0].sql, SQLSERVER_READONLY_PROBE);
  assert.equal(
    f.requests[1].sql,
    "SELECT TOP (1001) [id] FROM [dbo].[items] WHERE [id] = @p0",
  );
  assert.deepEqual(f.requests[1].parameters, [
    ["p0", TYPES.BigInt, "9223372036854775807"],
  ]);
  const config = f.connections[0].config;
  assert.equal(config.authentication.type, "default");
  assert.equal(config.options.encrypt, true);
  assert.equal(config.options.serverName, "fixture.invalid");
  assert.deepEqual(config.options.cryptoCredentialsDetails, {
    ca: "contract-only CA bytes",
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  });
  assert.equal(config.options.trustServerCertificate, false);
  assert.equal(config.options.fallbackToDefaultDb, false);
  assert.equal(config.options.readOnlyIntent, false);
  assert.equal(config.options.rowCollectionOnDone, false);
  assert.equal(config.options.rowCollectionOnRequestCompletion, false);
  assert.equal(config.options.maxRetriesOnTransientErrors, 0);
});
test("Tedious WIP rejects reroute/reconnect before another socket and rejects insecure/fallback database callbacks", async (t) => {
  for (const event of [
    "rerouting",
    "retry",
    "insecure",
    "databaseChange",
    "secondConnector",
  ]) {
    const f = fixture(t, {
      connect: (c, callback) => {
        if (event === "insecure") c.emit("secure", { authorized: false });
        else if (event === "databaseChange") c.emit(event, "master");
        else if (event !== "secondConnector") c.emit(event);
        // Test connector's independent one-call gate even without an event.
        c.config.options
          .connector({ host: "unapproved.invalid", port: 1444 })
          .catch(() => {});
        c.emit("secure", { authorized: true });
        callback(); // Deliberately late; must not become successful.
      },
    });
    await assert.rejects(
      runSQLServerReadWIP(input, { factory: f.factory }),
      /no result published/,
    );
    assert.equal(f.targets.length, 1);
    assert.equal(f.requests.length, 0);
    t.mock.restoreAll();
  }
});
test("Tedious WIP rejects READ_WRITE before user SQL, duplicate/multiple/unsafe/MAX metadata and sink failures", async (t) => {
  const f = fixture(t, { state: "READ_WRITE" });
  await assert.rejects(
    runSQLServerReadWIP(input, { factory: f.factory }),
    /no result published/,
  );
  assert.equal(f.requests.length, 1);
  t.mock.restoreAll();
  for (const query of [
    (r) => result(r, [col("DecimalN", 17)], [[1.25]]),
    (r) => result(r, [col("NVarChar", 65535)], [["large"]]),
    (r) => result(r, [col(), col()], [["1", "2"]]),
    (r) => {
      r.emit("columnMetadata", [col()]);
      result(r, [col()], [["1"]]);
    },
    (r) => result(r, [col()], [[9007199254740992]]),
  ]) {
    const f = fixture(t, { query });
    await assert.rejects(
      runSQLServerReadWIP(input, { factory: f.factory }),
      /no result published/,
    );
    assert.equal(f.requests[1].cancels, 1);
    t.mock.restoreAll();
  }
});
test("Tedious WIP abort ignores late connect/request callbacks and waits for actual driver end", async (t) => {
  for (const stage of ["connect", "query"]) {
    const controller = new AbortController();
    const behavior = {
      holdEnd: true,
      [stage]:
        stage === "connect"
          ? (c, callback) => {
              controller.abort();
              c.emit("secure", { authorized: true });
              callback();
            }
          : (r) => {
              controller.abort();
              result(r, [col()], [["1"]]);
            },
    };
    const f = fixture(t, behavior);
    let settled = false;
    const promise = runSQLServerReadWIP(input, {
      factory: f.factory,
      signal: controller.signal,
    });
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise(setImmediate);
    assert.equal(settled, false);
    assert.equal(f.sockets[0].destroyed, true);
    f.connections[0].emit("end");
    await assert.rejects(promise, /no result published|cancelled/);
    assert.equal(f.connections[0].closes, 1);
    if (stage === "connect") assert.equal(f.requests.length, 0);
    else assert.equal(f.requests[1].cancels, 1);
    t.mock.restoreAll();
  }
});
test("Tedious WIP request/closure deadlines are bounded without driver acknowledgement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, { holdEnd: true, query: () => {} });
  const p = f.factory(sqlServerConnectionContract(input.connection));
  await p.connect();
  const query = p.query(
    { sql: "internal test event only", parameters: [] },
    {},
  );
  const rejected = assert.rejects(query, /transport failed/);
  t.mock.timers.tick(2000);
  await rejected;
  const closed = assert.rejects(p.closed, /transport failed/);
  t.mock.timers.tick(2500);
  await closed;
  assert.equal(f.connections[0].closes, 1);
  assert.equal(f.requests[0].cancels, 1);
  f.requests[0].callback();
  f.connections[0].emit("end");
});
test("Tedious WIP real installed driver constructs/closes without connect and rejects extra options", async () => {
  const config = sqlServerConnectionContract(input.connection);
  const p = createTediousSQLServerPort(config);
  p.destroy();
  await p.closed;
  assert.throws(() =>
    createTediousSQLServerPort({
      ...config,
      options: { ...config.options, trustServerCertificate: true },
    }),
  );
  assert.throws(() =>
    createTediousSQLServerPort({
      ...config,
      authentication: { type: "azure-active-directory-default" },
    }),
  );
});

test("Tedious WIP success waits for owned socket close even after driver end", async (t) => {
  let releaseClose;
  const f = fixture(t, {
    query: (r) => {
      const socket = f.sockets[0];
      const emit = socket.emit;
      t.mock.method(socket, "emit", function (name, ...args) {
        if (name === "close") {
          releaseClose = () => emit.call(this, name, ...args);
          return true;
        }
        return emit.call(this, name, ...args);
      });
      result(r, [col()], [["1"]]);
    },
  });
  let settled = false;
  const promise = runSQLServerReadWIP(input, { factory: f.factory });
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise(setImmediate);
  assert.equal(f.connections[0].closes, 1);
  assert.equal(typeof releaseClose, "function");
  assert.equal(settled, false);
  releaseClose();
  assert.equal((await promise).rows[0].id, "1");
});

test("Tedious WIP adapter events preserve truncation sentinel and reject row/byte overflow", async (t) => {
  for (const count of [1001, 1002]) {
    const f = fixture(t, {
      query: (r) =>
        result(
          r,
          [col("IntN", 4)],
          Array.from({ length: count }, (_, i) => [i]),
        ),
    });
    const promise = runSQLServerReadWIP(input, { factory: f.factory });
    if (count === 1001) {
      const r = await promise;
      assert.equal(r.rows.length, 1000);
      assert.equal(r.truncated, true);
    } else await assert.rejects(promise, /no result published/);
    t.mock.restoreAll();
  }
  const f = fixture(t, {
    query: (r) =>
      result(
        r,
        [col("NVarChar", 8000)],
        Array.from({ length: 300 }, () => ["x".repeat(4000)]),
      ),
  });
  await assert.rejects(
    runSQLServerReadWIP(input, { factory: f.factory }),
    /no result published/,
  );
  assert.equal(f.requests[1].cancels, 1);
});
