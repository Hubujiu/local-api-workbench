// Isolated event-contract tests only. No real Socket, server, TDS or TLS handshake.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { TYPES } from "tedious";
import { createTediousSQLServerPort } from "../src/sqlserver-tedious-prep.mjs";
import { sqlServerConnectionContract } from "../src/sqlserver-driver-contract.mjs";
import {
  runSQLServerReadPreparation,
  SQLSERVER_READONLY_PROBE,
} from "../src/sqlserver-read-prep.mjs";
const input = {
  connection: {
    host: "fixture.invalid",
    user: "fixture",
    password: "private-secret",
    database: "fixture",
    ssl: true,
  },
  sql: "SELECT id FROM dbo.items WHERE id=@p0",
  parameters: [{ type: "int64", value: "9223372036854775807" }],
};
const col = (name = "id", type = "IntN", dataLength = 8) => ({
  colName: name,
  type: { name: type },
  dataLength,
});
function result(r, columns = [col()], rows = [["9223372036854775807"]]) {
  r.emit("columnMetadata", columns);
  for (const values of rows)
    r.emit(
      "row",
      values.map((value, i) => ({ metadata: columns[i], value })),
    );
  r.emit("doneInProc", rows.length, true);
  r.emit("doneProc", undefined, false, 0);
  r.callback();
}
function fixture(behavior = {}) {
  const connections = [],
    sockets = [],
    requests = [],
    targets = [];
  class S extends EventEmitter {
    constructor() {
      super();
      sockets.push(this);
    }
    connect(target) {
      targets.push(target);
      queueMicrotask(() => {
        if (!this.destroyed) this.emit("connect");
      });
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      if (!behavior.holdSocket) queueMicrotask(() => this.emit("close"));
    }
  }
  class C extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this.closes = 0;
      connections.push(this);
    }
    connect(callback) {
      this.callback = callback;
      this.config.options.connector().then(() => {
        if (behavior.connect) return behavior.connect(this, callback);
        this.emit("secure", { authorized: true });
        this.emit("databaseChange", "fixture");
        callback();
      }, callback);
    }
    execSql(r) {
      requests.push(r);
      if (r.sql === SQLSERVER_READONLY_PROBE)
        result(
          r,
          [col("updateability", "NVarChar", 120)],
          [[behavior.state ?? "READ_ONLY"]],
        );
      else if (behavior.query) behavior.query(r, this);
      else result(r);
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
      this.callback(Error("private driver failure"));
    }
  }
  return {
    connections,
    sockets,
    requests,
    targets,
    factory: (config) =>
      createTediousSQLServerPort(config, {
        Connection: C,
        Request: R,
        Socket: S,
      }),
  };
}
async function until(fn) {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw Error("fixture deadline");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function observed(promise) {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}
test("prep uses explicit TLS, one fixed target, exact bound parameters and no public provider", async () => {
  const f = fixture();
  const r = await runSQLServerReadPreparation(input, { factory: f.factory });
  assert.equal(r.rows[0].id, "9223372036854775807");
  assert.equal(f.connections.length, 1);
  assert.equal(f.targets.length, 1);
  assert.deepEqual(f.targets[0], {
    host: "fixture.invalid",
    port: 1433,
    autoSelectFamily: false,
  });
  const c = f.connections[0].config;
  assert.equal(c.options.encrypt, true);
  assert.equal(c.options.trustServerCertificate, false);
  assert.equal(c.options.cryptoCredentialsDetails.rejectUnauthorized, true);
  assert.equal(c.options.cryptoCredentialsDetails.minVersion, "TLSv1.2");
  assert.equal(c.options.serverName, "fixture.invalid");
  assert.equal(c.options.maxRetriesOnTransientErrors, 0);
  assert.equal(c.options.fallbackToDefaultDb, false);
  assert.equal(c.options.readOnlyIntent, false);
  assert.equal(c.options.multiSubnetFailover, false);
  assert.equal(c.options.rowCollectionOnRequestCompletion, false);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].parameters, [
    ["p0", TYPES.BigInt, "9223372036854775807"],
  ]);
  assert.match(f.requests[1].sql, /^SELECT TOP \(1001\) \[id\]/);
  assert.equal(f.sockets[0].destroyed, true);
  assert.equal(f.connections[0].closes, 1);
  for (const file of [
    "database-sessions.mjs",
    "remote-database.mjs",
    "server.mjs",
    "mcp.mjs",
  ]) {
    assert.doesNotMatch(
      await readFile(new URL(`../src/${file}`, import.meta.url), "utf8"),
      /sqlserver-(?:read-prep|tedious-prep)/,
    );
  }
});
test("prep rejects unsafe config and accessors without executing them", () => {
  let hits = 0;
  const bad = {
    ...input.connection,
    get host() {
      hits++;
      throw Error("secret");
    },
  };
  assert.throws(() => sqlServerConnectionContract(bad));
  assert.equal(hits, 0);
  assert.throws(() =>
    sqlServerConnectionContract(new Proxy(input.connection, {})),
  );
  for (const extra of [
    { ssl: false },
    { port: 0 },
    { instanceName: "ignored" },
    { user: "" },
  ])
    assert.throws(() =>
      sqlServerConnectionContract({ ...input.connection, ...extra }),
    );
  const cfg = sqlServerConnectionContract(input.connection);
  assert.throws(() =>
    createTediousSQLServerPort({
      ...cfg,
      options: { ...cfg.options, trustServerCertificate: true },
    }),
  );
  assert.throws(() =>
    createTediousSQLServerPort({
      get server() {
        hits++;
        return "x";
      },
    }),
  );
  assert.equal(hits, 0);
});
test("prep abort during async compilation allocates no driver", async () => {
  const f = fixture(),
    controller = new AbortController();
  const p = runSQLServerReadPreparation(input, {
    factory: f.factory,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(p, /cancelled/);
  assert.equal(f.connections.length, 0);
});
test("prep has no implicit driver factory", async () => {
  await assert.rejects(
    runSQLServerReadPreparation(input),
    /no installed transport/,
  );
});
test("prep security failures never reroute, retry, replay or expose driver secrets", async () => {
  for (const event of [
    "retry",
    "rerouting",
    "errorMessage",
    "insecure",
    "wrongDatabase",
    "secondConnector",
    "missingTLS",
  ]) {
    const f = fixture({
      connect: (c, cb) => {
        if (event === "insecure") c.emit("secure", { authorized: false });
        else if (event === "wrongDatabase") c.emit("databaseChange", "master");
        else if (event === "secondConnector")
          c.config.options.connector({ host: "other.invalid" }).catch(() => {});
        else if (event !== "missingTLS") c.emit(event, Error("private-secret"));
        if (event !== "missingTLS") c.emit("secure", { authorized: true });
        c.emit("databaseChange", "fixture");
        cb();
        cb();
      },
    });
    await assert.rejects(
      runSQLServerReadPreparation(input, { factory: f.factory }),
      (e) => !/private-secret/.test(e.message),
    );
    assert.equal(f.targets.length, 1);
    assert.equal(f.requests.length, 0);
  }
});
test("prep READ_WRITE fails before generated SQL, and late rows cannot rescue a failed request", async () => {
  const f = fixture({ state: "READ_WRITE" });
  await assert.rejects(
    runSQLServerReadPreparation(input, { factory: f.factory }),
    /no result published/,
  );
  assert.equal(f.requests.length, 1);
  const g = fixture({
    query: (r) => {
      r.callback(Error("private-secret"));
      result(r);
    },
  });
  await assert.rejects(
    runSQLServerReadPreparation(input, { factory: g.factory }),
    /no result published/,
  );
  assert.equal(g.requests.length, 2);
  assert.equal(g.connections[0].closes, 1);
});
test("prep success waits for both driver end and socket close in either order", async () => {
  for (const first of ["end", "close"]) {
    const f = fixture({ holdEnd: true, holdSocket: true });
    const p = runSQLServerReadPreparation(input, { factory: f.factory }),
      state = observed(p);
    await until(() => f.sockets[0]?.destroyed);
    assert.equal(state.settled, false);
    if (first === "end") f.connections[0].emit("end");
    else f.sockets[0].emit("close");
    await new Promise(setImmediate);
    assert.equal(state.settled, false);
    if (first === "end") f.sockets[0].emit("close");
    else f.connections[0].emit("end");
    assert.equal((await p).rows.length, 1);
  }
});
test("prep revoke during connect or query ignores late callbacks and waits for both receipts", async () => {
  for (const stage of ["connect", "query"]) {
    const controller = new AbortController();
    const f = fixture({
      holdEnd: true,
      holdSocket: true,
      [stage]:
        stage === "connect"
          ? (c, cb) => {
              controller.abort();
              c.emit("secure", { authorized: true });
              c.emit("databaseChange", "fixture");
              cb();
            }
          : (r) => {
              controller.abort();
              result(r);
            },
    });
    const p = runSQLServerReadPreparation(input, {
        factory: f.factory,
        signal: controller.signal,
      }),
      state = observed(p);
    await until(() => f.sockets[0]?.destroyed);
    assert.equal(state.settled, false);
    f.connections[0].emit("end");
    await new Promise(setImmediate);
    assert.equal(state.settled, false);
    f.sockets[0].emit("close");
    await assert.rejects(p, /cancelled/);
    assert.equal(f.requests.length, stage === "connect" ? 0 : 2);
    assert.equal(f.connections[0].closes, 1);
  }
});
test("prep revoke while successful result awaits closure discards the buffered result", async () => {
  const f = fixture({ holdSocket: true }),
    controller = new AbortController();
  const p = runSQLServerReadPreparation(input, {
    factory: f.factory,
    signal: controller.signal,
  });
  observed(p);
  await until(() => f.sockets[0]?.destroyed);
  controller.abort();
  f.sockets[0].emit("close");
  await assert.rejects(p, /cancelled/);
});
test("prep operation deadline does not manufacture closure receipts", async (t) => {
  const f = fixture({ query: () => {}, holdEnd: true, holdSocket: true });
  const p = runSQLServerReadPreparation(input, { factory: f.factory }),
    state = observed(p);
  await until(() => f.requests.length === 2);
  await until(() => f.sockets[0].destroyed);
  assert.equal(state.settled, false);
  assert.equal(f.requests[1].cancels, 1);
  f.requests[1].callback();
  f.connections[0].emit("end");
  await new Promise(setImmediate);
  assert.equal(state.settled, false);
  f.sockets[0].emit("close");
  await assert.rejects(p, /no result published/);
  assert.equal(f.targets.length, 1);
  assert.equal(f.requests.length, 2);
});
test("prep rejects unsafe metadata, lossy values, second resultsets and row/byte overflow with no partial output", async () => {
  for (const query of [
    (r) => result(r, [col("id", "DecimalN", 17)], [[1.25]]),
    (r) => result(r, [col("id", "NVarChar", 65535)], [["x"]]),
    (r) => result(r, [col(), col()], [["1", "2"]]),
    (r) => {
      r.emit("columnMetadata", [col()]);
      result(r);
    },
    (r) => result(r, [col()], [[9007199254740992]]),
    (r) =>
      result(
        r,
        [col("id", "IntN", 4)],
        Array.from({ length: 1001 }, (_, i) => [i]),
      ),
    (r) =>
      result(
        r,
        [col("id", "NVarChar", 8000)],
        Array.from({ length: 300 }, () => ["x".repeat(4000)]),
      ),
    (r) => {
      r.emit("columnMetadata", [col()]);
      r.emit("row", [{ metadata: col("other"), value: "1" }]);
      r.callback();
    },
  ]) {
    const f = fixture({ query });
    await assert.rejects(
      runSQLServerReadPreparation(input, { factory: f.factory }),
      /no result published/,
    );
    assert.equal(f.requests[1].cancels, 1);
    assert.equal(f.targets.length, 1);
  }
});
test("prep binds only compiler-produced null, Unicode, bit, int32 and exact int64 values", async () => {
  const f = fixture();
  await runSQLServerReadPreparation(
    {
      ...input,
      sql: "SELECT id FROM dbo.items WHERE a=@p0 AND b=@p1 AND c=@p2 AND d=@p3 AND e=@p4",
      parameters: [
        null,
        "汉字😀",
        true,
        -2147483648,
        { type: "int64", value: "-9223372036854775808" },
      ],
    },
    { factory: f.factory },
  );
  assert.deepEqual(f.requests[1].parameters, [
    ["p0", TYPES.NVarChar, null],
    ["p1", TYPES.NVarChar, "汉字😀"],
    ["p2", TYPES.Bit, true],
    ["p3", TYPES.Int, -2147483648],
    ["p4", TYPES.BigInt, "-9223372036854775808"],
  ]);
});
