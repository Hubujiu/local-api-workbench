import test from "node:test";
import assert from "node:assert/strict";
import { compileOracleRead } from "../src/oracle-read-contract.mjs";
import { executeOracleRead } from "../src/oracle-read.mjs";
import { queryOracleRead } from "../src/oracle-read-process.mjs";
import { oracleInput } from "./helpers/oracle-fixture.mjs";
function fixture({
  rows = [["1", "9007199254740993.123456789"]],
  closeError = false,
  beforeRow,
} = {}) {
  const calls = [];
  let index = 0;
  const driver = {
    thin: true,
    OUT_FORMAT_ARRAY: 1,
    DB_TYPE_NUMBER: 2,
    DB_TYPE_VARCHAR: 3,
    DB_TYPE_NVARCHAR: 4,
    DB_TYPE_CHAR: 5,
    DB_TYPE_NCHAR: 6,
    DB_TYPE_RAW: 7,
  };
  const connection = {
    thin: true,
    async execute(sql, binds, options) {
      calls.push({ sql, binds, options });
      if (sql.startsWith("SET ")) return {};
      assert.deepEqual(options.fetchTypeHandler({ dbType: 2 }), { type: 3 });
      assert.throws(() => options.fetchTypeHandler({ dbType: 99 }));
      assert.throws(() =>
        options.fetchTypeHandler({ dbType: 3, byteSize: 1000000 }),
      );
      return {
        metaData: [{ name: "ID" }, { name: "AMOUNT" }],
        resultSet: {
          async getRow() {
            beforeRow?.();
            return rows[index++];
          },
          async close() {
            calls.push("result-close");
          },
        },
      };
    },
    async rollback() {
      calls.push("rollback");
    },
    async close() {
      calls.push("close");
      if (closeError) throw Error("private-secret");
    },
    async break() {
      calls.push("break");
    },
  };
  driver.getConnection = async (config) => {
    calls.push({ config });
    return connection;
  };
  return { driver, calls, connection };
}
test("Oracle compiler regenerates one bounded local SELECT with binds and fixed TCPS", () => {
  const p = compileOracleRead(oracleInput());
  assert.match(p.sql, /FETCH FIRST 1001 ROWS ONLY$/);
  assert.equal(p.binds.p0, 1);
  assert.match(p.config.connectString, /^tcps:.*retry_count=0/);
  assert.equal(p.config.sslServerDNMatch, true);
  assert.equal(p.config.sslAllowWeakDNMatch, false);
  assert.doesNotMatch(p.sql, /private-secret/);
});
test("rejects expressions, remote links, procedural/multiple SQL and connection injection", () => {
  for (const sql of [
    "SELECT * FROM fixture.items",
    "SELECT f() FROM fixture.items",
    "SELECT id FROM fixture.items@remote",
    "SELECT id FROM fixture.items FOR UPDATE",
    "SELECT id FROM fixture.items;DELETE FROM fixture.items",
    "BEGIN NULL; END;",
    "SELECT id FROM fixture.items WHERE id=1",
    "SELECT id FROM fixture.items WHERE id=:p0 OR id=:p1",
    "SELECT id, ID FROM fixture.items",
  ])
    assert.throws(() => compileOracleRead({ ...oracleInput(), sql }));
  for (const patch of [
    { host: "host?wallet_location=/tmp" },
    { database: "x)(HOST=evil" },
    { ssl: false },
    { port: "2484" },
    { password: undefined },
    { connectString: "evil" },
    { serverDN: undefined },
  ])
    assert.throws(() =>
      compileOracleRead({
        ...oracleInput(),
        connection: { ...oracleInput().connection, ...patch },
      }),
    );
  let called = 0;
  const a = oracleInput();
  Object.defineProperty(a, "parameters", {
    get() {
      called++;
      return [];
    },
  });
  assert.throws(() => compileOracleRead(a));
  assert.equal(called, 0);
});
test("actual adapter execution waits for read transaction, result close, rollback and connection close", async () => {
  const f = fixture();
  const r = await executeOracleRead(oracleInput(), f);
  assert.deepEqual(r.rows, [{ ID: "1", AMOUNT: "9007199254740993.123456789" }]);
  assert.equal(f.calls[1].sql, "SET TRANSACTION READ ONLY");
  assert.deepEqual(f.calls.slice(-3), ["result-close", "rollback", "close"]);
  assert.equal(f.connection.callTimeout, 2000);
});
test("lossy values, result overflow, failed closure and cancellation never publish partial success", async () => {
  for (const setup of [
    { rows: [[1, "2"]] },
    { rows: Array(1001).fill(["1", "2"]) },
    { rows: [["1", "x".repeat(1048576)]] },
    { closeError: true },
  ]) {
    const f = fixture(setup);
    await assert.rejects(
      executeOracleRead(oracleInput(), f),
      /ORACLE_READ_FAILED_NO_RESULT/,
    );
    assert.equal(f.calls.at(-1), "close");
  }
  const c = new AbortController();
  const f = fixture({ beforeRow: () => c.abort("private-secret") });
  await assert.rejects(
    executeOracleRead(oracleInput(), { ...f, signal: c.signal }),
    /ORACLE_READ_CANCELLED/,
  );
  assert.equal(f.calls.at(-1), "close");
  await assert.rejects(
    queryOracleRead(oracleInput(), { signal: c.signal }),
    /ORACLE_READ_CANCELLED/,
  );
});
test("pre-abort and invalid input never allocate driver", async () => {
  let connections = 0;
  const driver = {
    thin: true,
    getConnection() {
      connections++;
      throw Error();
    },
  };
  await assert.rejects(
    executeOracleRead(
      { ...oracleInput(), sql: "DELETE FROM fixture.items" },
      { driver },
    ),
  );
  await assert.rejects(
    executeOracleRead(oracleInput(), { driver, signal: AbortSignal.abort() }),
  );
  assert.equal(connections, 0);
});
