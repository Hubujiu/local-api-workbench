import test from "node:test";
import assert from "node:assert/strict";
import { runOracleReadWithDriver } from "../src/oracle-read-wip.mjs";

const input = (patch = {}) => ({
  host: "db.example.test",
  port: 1521,
  service: "FREEPDB1",
  user: "reader",
  password: "secret",
  ssl: true,
  sql: "SELECT amount FROM data WHERE id = :1",
  parameters: [{ type: "int64", value: "9223372036854775807" }],
  ...patch,
});
function fixture({
  rows = [["12345678901234567890.12345"]],
  fail,
  statementType = "SELECT",
  metadata,
  rawMetadata,
  expectedSQL = input().sql,
} = {}) {
  const calls = [];
  const driver = Object.fromEntries(
    [
      "DB_TYPE_NUMBER",
      "DB_TYPE_VARCHAR",
      "DB_TYPE_CHAR",
      "DB_TYPE_NCHAR",
      "DB_TYPE_NVARCHAR",
      "DB_TYPE_RAW",
      "BIND_IN",
      "OUT_FORMAT_ARRAY",
    ].map((x) => [x, x]),
  );
  driver.thin = true;
  driver.STMT_TYPE_SELECT = "SELECT";
  metadata ??= [{ name: "AMOUNT", dbType: driver.DB_TYPE_NUMBER }];
  const step = async (name) => {
    calls.push(name);
    if (fail === name) throw Error("private password=secret and SQL");
  };
  let row = 0;
  const resultSet = {
    metaData: metadata,
    async getRows(n) {
      assert.equal(n, 1);
      await step("fetch");
      return row < rows.length ? [rows[row++]] : [];
    },
    async close() {
      await step("result.close");
    },
  };
  const connection = {
    thin: true,
    async execute(sql, binds, options) {
      if (sql === "SET TRANSACTION READ ONLY") {
        await step("readonly");
        assert.equal(options.autoCommit, false);
        return {};
      }
      await step("execute");
      assert.equal(sql, expectedSQL);
      assert.equal(options.autoCommit, false);
      assert.equal(options.resultSet, true);
      assert.equal(options.outFormat, driver.OUT_FORMAT_ARRAY);
      assert.equal(options.prefetchRows, 0);
      assert.equal(options.fetchArraySize, 1);
      // Model 26.0.0: describe/result metadata can already have renamed names,
      // while fetchTypeHandler sees originals and future raw dbTypes are not
      // necessarily normalized until each column's turn.
      const raw = (rawMetadata ?? metadata).map((column) => ({ ...column }));
      for (let i = 0; i < raw.length; i++) {
        raw[i].dbType = metadata[i].dbType;
        assert.deepEqual(
          options.fetchTypeHandler({ ...raw[i] }, raw),
          metadata[i].dbType === driver.DB_TYPE_NUMBER
            ? { type: driver.DB_TYPE_VARCHAR }
            : undefined,
        );
      }
      assert.deepEqual(binds, [
        {
          dir: driver.BIND_IN,
          type: driver.DB_TYPE_NUMBER,
          val: 9223372036854775807n,
        },
      ]);
      return { metaData: metadata, resultSet };
    },
    async getStatementInfo(sql) {
      await step("classify");
      assert.equal(sql, expectedSQL);
      return { statementType, metaData: metadata };
    },
    async rollback() {
      await step("rollback");
    },
    async close() {
      await step("connection.close");
    },
  };
  driver.getConnection = async (options) => {
    await step("connect");
    assert.equal(options.password, "secret");
    assert.equal(options.externalAuth, false);
    assert.equal(options.retryCount, 0);
    return connection;
  };
  return { driver, connection, calls, resultSet };
}

test("unregistered injected Oracle read preserves NUMBER text and closes all owned resources", async () => {
  const f = fixture(),
    phases = [];
  const result = await runOracleReadWithDriver(input(), {
    driver: f.driver,
    onPhase: (x) => phases.push(x),
  });
  assert.deepEqual(result, {
    columns: ["AMOUNT"],
    rows: [{ AMOUNT: "12345678901234567890.12345" }],
    truncated: false,
    limit: 1000,
  });
  assert.deepEqual(f.calls, [
    "connect",
    "readonly",
    "classify",
    "execute",
    "fetch",
    "fetch",
    "result.close",
    "rollback",
    "connection.close",
  ]);
  assert.deepEqual(phases, [
    "connect",
    "setup",
    "classify",
    "query",
    "cleanup",
  ]);
  assert.equal(f.connection.callTimeout, 2000);
});

test("non-SELECT/unknown classification never executes caller SQL", async () => {
  for (const statementType of ["INSERT", "DDL", "UNKNOWN", undefined, 0]) {
    const f = fixture({
      statementType: statementType === undefined ? null : statementType,
    });
    await assert.rejects(
      runOracleReadWithDriver(input(), { driver: f.driver }),
      { code: "ORACLE_WIP_QUERY_FAILED" },
    );
    assert.ok(!f.calls.includes("execute"));
    assert.deepEqual(f.calls.slice(-2), ["rollback", "connection.close"]);
  }
});

test("driver, connection, and caller pre-abort fail closed", async () => {
  await assert.rejects(runOracleReadWithDriver(input()), {
    code: "ORACLE_WIP_DRIVER_UNAVAILABLE",
  });
  const f = fixture();
  f.driver.thin = false;
  await assert.rejects(runOracleReadWithDriver(input(), { driver: f.driver }), {
    code: "ORACLE_WIP_DRIVER_UNAVAILABLE",
  });
  assert.deepEqual(f.calls, []);
  const other = fixture();
  other.connection.thin = false;
  await assert.rejects(
    runOracleReadWithDriver(input(), { driver: other.driver }),
  );
  assert.ok(!other.calls.includes("readonly"));
  const c = new AbortController();
  c.abort();
  const never = fixture();
  await assert.rejects(
    runOracleReadWithDriver(input(), {
      driver: never.driver,
      signal: c.signal,
    }),
    { name: "AbortError", code: "ORACLE_WIP_CANCELLED" },
  );
  assert.deepEqual(never.calls, []);
});

test("failures are sanitized and cleanup continues after individual cleanup errors", async () => {
  for (const fail of [
    "connect",
    "readonly",
    "classify",
    "execute",
    "fetch",
    "result.close",
    "rollback",
    "connection.close",
  ]) {
    const f = fixture({ fail });
    await assert.rejects(
      runOracleReadWithDriver(input(), { driver: f.driver }),
      (error) => {
        assert.ok(!error.message.includes("secret"));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    if (fail !== "connect") assert.equal(f.calls.at(-1), "connection.close");
    if (
      ["fetch", "result.close", "rollback", "connection.close"].includes(fail)
    )
      assert.ok(f.calls.includes("result.close"));
  }
});

test("unsupported or already-invalid describe metadata rejects before query execution", async () => {
  for (const metadata of [
    [{ name: "DATA", dbType: "DB_TYPE_CLOB" }],
    [
      { name: "A", dbType: "DB_TYPE_VARCHAR" },
      { name: "A", dbType: "DB_TYPE_VARCHAR" },
    ],
  ]) {
    const f = fixture({ metadata });
    await assert.rejects(
      runOracleReadWithDriver(input(), { driver: f.driver }),
    );
    assert.ok(!f.calls.includes("execute"));
  }
});

test("row probe is bounded at 1001 and byte overflow fails without partial delivery", async () => {
  const f = fixture({ rows: Array.from({ length: 1002 }, () => ["1"]) });
  const result = await runOracleReadWithDriver(input(), { driver: f.driver });
  assert.equal(result.rows.length, 1000);
  assert.equal(result.truncated, true);
  assert.equal(f.calls.filter((x) => x === "fetch").length, 1001);
  const huge = fixture({ rows: [["1".repeat(1024 * 1024)]] });
  await assert.rejects(
    runOracleReadWithDriver(input(), { driver: huge.driver }),
  );
  assert.deepEqual(huge.calls.slice(-3), [
    "result.close",
    "rollback",
    "connection.close",
  ]);
});

test("abort after an awaited stage prevents adapter resubmission of caller SQL", async () => {
  for (const phase of ["setup", "classify", "query"]) {
    const f = fixture(),
      c = new AbortController();
    await assert.rejects(
      runOracleReadWithDriver(input(), {
        driver: f.driver,
        signal: c.signal,
        onPhase: (value) => {
          if (value === phase) c.abort();
        },
      }),
      { code: "ORACLE_WIP_CANCELLED" },
    );
    assert.ok(!f.calls.includes("execute"));
    assert.equal(f.calls.filter((x) => x === "connect").length, 1);
    assert.equal(f.calls.at(-1), "connection.close");
  }
});

test("cleanup reporting failure cannot skip actual cleanup", async () => {
  const f = fixture();
  await assert.rejects(
    runOracleReadWithDriver(input(), {
      driver: f.driver,
      onPhase: (phase) => {
        if (phase === "cleanup") throw Error("secret");
      },
    }),
    { code: "ORACLE_WIP_CLEANUP_FAILED" },
  );
  assert.deepEqual(f.calls.slice(-3), [
    "result.close",
    "rollback",
    "connection.close",
  ]);
});

test("tiny and large Oracle NUMBER text is returned without numeric coercion", async () => {
  const number =
    "0." + "0".repeat(129) + "12345678901234567890123456789012345678";
  const f = fixture({ rows: [[number]] });
  const value = await runOracleReadWithDriver(input(), { driver: f.driver });
  assert.equal(value.rows[0].AMOUNT, number);
});

test("original duplicate aliases reject even when describe already renamed them", async () => {
  const sql = "SELECT 1 AS duplicate_name, 2 AS duplicate_name FROM DUAL";
  const f = fixture({
    expectedSQL: sql,
    rows: [["1", "2"]],
    metadata: [
      { name: "DUPLICATE_NAME", dbType: "DB_TYPE_NUMBER" },
      { name: "DUPLICATE_NAME_1", dbType: "DB_TYPE_NUMBER" },
    ],
    rawMetadata: [
      { name: "DUPLICATE_NAME", dbType: 2010 },
      { name: "DUPLICATE_NAME", dbType: 2010 },
    ],
  });
  await assert.rejects(
    runOracleReadWithDriver(input({ sql }), { driver: f.driver }),
    { code: "ORACLE_WIP_QUERY_FAILED" },
  );
  assert.ok(f.calls.includes("execute")); // Cannot promise pre-execution rejection.
  assert.ok(!f.calls.includes("fetch"));
  assert.deepEqual(f.calls.slice(-2), ["rollback", "connection.close"]);
});

test("unique multi-column raw names allow later columns whose types are not normalized yet", async () => {
  const sql = "SELECT 1 AS amount, 'label' AS label FROM DUAL";
  const f = fixture({
    expectedSQL: sql,
    rows: [["1", "label"]],
    metadata: [
      { name: "AMOUNT", dbType: "DB_TYPE_NUMBER" },
      { name: "LABEL", dbType: "DB_TYPE_VARCHAR" },
    ],
    rawMetadata: [
      { name: "AMOUNT", dbType: 2010 },
      { name: "LABEL", dbType: 2001 },
    ],
  });
  const value = await runOracleReadWithDriver(input({ sql }), {
    driver: f.driver,
  });
  assert.deepEqual(value, {
    columns: ["AMOUNT", "LABEL"],
    rows: [{ AMOUNT: "1", LABEL: "label" }],
    truncated: false,
    limit: 1000,
  });
});

test("pinned driver's UNKNOWN classification keeps WITH/CTE unsupported", async () => {
  const sql =
    "WITH values_cte AS (SELECT 1 AS n FROM DUAL) SELECT n FROM values_cte";
  const f = fixture({ expectedSQL: sql, statementType: "UNKNOWN" });
  await assert.rejects(
    runOracleReadWithDriver(input({ sql }), { driver: f.driver }),
    { code: "ORACLE_WIP_QUERY_FAILED" },
  );
  assert.ok(!f.calls.includes("execute"));
});
