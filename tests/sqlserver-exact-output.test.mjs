// Inert exchange only: no SQL Server, TDS, real catalog or TLS acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import { compileSQLServerRead } from "../src/sqlserver-read-contract.mjs";
import {
  exactCatalogPlan,
  exactProjectionPlan,
  validateExactResult,
} from "../src/sqlserver-exact-output.mjs";
import {
  runSQLServerReadPreparation,
  SQLSERVER_READONLY_PROBE,
} from "../src/sqlserver-read-prep.mjs";
const columns = ["name", "type", "precision", "scale", "computed", "encrypted"];
const meta = (name, type, precision = 0, scale = 0) => ({
  name,
  type,
  precision,
  scale,
  computed: 0,
  encrypted: 0,
});
const schema = {
  columns,
  rows: [
    meta("amount", "decimal", 38, 18),
    meta("stamp", "datetime2", 27, 7),
    meta("offset_stamp", "datetimeoffset", 34, 7),
    meta("clock", "time", 16, 7),
    meta("day", "date", 10, 0),
  ],
};
const sql =
  "SELECT amount, stamp, offset_stamp, clock, day FROM dbo.items WHERE amount=@p0 ORDER BY amount";
const input = {
  connection: {
    host: "fixture.invalid",
    user: "fixture",
    password: "unused",
    database: "fixture",
    ssl: true,
  },
  sql,
  parameters: [
    {
      type: "decimal",
      value: "9007199254740993.123456789012345678",
      precision: 38,
      scale: 18,
    },
  ],
};
const values = [
  "9007199254740993.123456789012345678",
  "2026-11-18T02:03:04.1234567",
  "2026-11-18T02:03:04.1234567+05:30",
  "02:03:04.1234567",
  "0001-01-01",
];
test("exact projections use bounded server type metadata, explicit widths and styles", async () => {
  const plan = await compileSQLServerRead(sql, input.parameters);
  const catalog = exactCatalogPlan(plan);
  assert.equal(catalog.parameters[0].value, "dbo");
  assert.equal(catalog.parameters[1].value, "items");
  assert.match(catalog.sql, /TOP \(129\)/);
  const p = exactProjectionPlan(plan, schema);
  assert.match(p.sql, /CONVERT\(varchar\(41\), \[amount\]\)/);
  assert.match(p.sql, /CONVERT\(varchar\(27\), \[stamp\], 126\)/);
  assert.match(p.sql, /CONVERT\(varchar\(34\), \[offset_stamp\], 127\)/);
  assert.match(p.sql, /CONVERT\(varchar\(16\), \[clock\], 126\)/);
  assert.match(p.sql, /CONVERT\(varchar\(10\), \[day\], 23\)/);
  assert.match(p.sql, /ORDER BY \[items\]\.\[amount\] ASC$/);
  assert.ok(!p.sql.includes(input.parameters[0].value));
  const result = {
    columns: p.columns.map((c) => c.name),
    rows: [Object.fromEntries(p.columns.map((c, i) => [c.name, values[i]]))],
  };
  validateExactResult(result, p.columns);
  for (const bad of [
    9007199254740993,
    "9007199254740993.12345678901234567",
    "1e20",
    "123456789012345678901.123456789012345678",
  ]) {
    assert.throws(() =>
      validateExactResult(
        { ...result, rows: [{ ...result.rows[0], amount: bad }] },
        p.columns,
      ),
    );
  }
  for (const bad of [
    new Date(),
    "2026-11-18T02:03:04.12345678",
    "2026-11-18 02:03:04.1234567",
  ]) {
    assert.throws(() =>
      validateExactResult(
        { ...result, rows: [{ ...result.rows[0], stamp: bad }] },
        p.columns,
      ),
    );
  }
});
test("missing, extra, alias, computed, encrypted and unsupported metadata fail closed", async () => {
  const plan = await compileSQLServerRead(sql, input.parameters);
  const variants = [
    { columns, rows: schema.rows.slice(1) },
    { columns, rows: [...schema.rows, meta("extra", "int")] },
    { columns, rows: [...schema.rows, schema.rows[0]] },
    ...[
      { type: "money" },
      { type: "float" },
      { type: "datetime" },
      { type: "custom_decimal" },
      { computed: 1 },
      { encrypted: 1 },
      { scale: 39 },
      { precision: 39 },
      { name: "AMOUNT" },
    ].map((change) => ({
      columns,
      rows: [{ ...schema.rows[0], ...change }, ...schema.rows.slice(1)],
    })),
  ];
  for (const m of variants) assert.throws(() => exactProjectionPlan(plan, m));
});
function fixture({
  catalog = schema,
  output = values,
  readonly = "READ_ONLY",
  closeFails = false,
} = {}) {
  const sent = [];
  let closed = false,
    resolve,
    reject;
  const closure = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return {
    sent,
    get closed() {
      return closed;
    },
    factory: () => ({
      closed: closure,
      connect: async () => {},
      async query(plan, sink) {
        sent.push(plan);
        if (plan.sql === SQLSERVER_READONLY_PROBE) {
          sink.metadata([{ name: "updateability", type: "NVarChar" }]);
          sink.row([readonly]);
        } else if (plan.sql.includes("FROM sys.columns")) {
          sink.metadata(
            columns.map((name, i) => ({
              name,
              type: i < 2 ? "NVarChar" : "Int",
            })),
          );
          for (const r of catalog.rows) sink.row(columns.map((n) => r[n]));
        } else {
          sink.metadata(
            schema.rows.map((r) => ({ name: r.name, type: "VarChar" })),
          );
          sink.row(output);
        }
      },
      destroy() {
        closed = true;
        closeFails ? reject(Error("inert close failure")) : resolve();
      },
    }),
  };
}
test("owned execution reads catalog before exact text query and closes before publishing", async () => {
  const f = fixture();
  const result = await runSQLServerReadPreparation(input, {
    factory: f.factory,
    exactOutput: true,
  });
  assert.equal(f.sent.length, 3);
  assert.equal(f.closed, true);
  assert.deepEqual(Object.values(result.rows[0]), values);
  assert.match(f.sent[2].sql, /CONVERT\(varchar/);
});
test("read-write skips catalog; bad metadata skips data; invalid output/closure publishes nothing", async () => {
  for (const [options, count] of [
    [{ readonly: "READ_WRITE" }, 1],
    [{ catalog: { columns, rows: [] } }, 2],
    [{ output: [123, ...values.slice(1)] }, 3],
    [{ closeFails: true }, 3],
  ]) {
    const f = fixture(options);
    await assert.rejects(
      runSQLServerReadPreparation(input, {
        factory: f.factory,
        exactOutput: true,
      }),
    );
    assert.equal(f.sent.length, count);
    assert.equal(f.closed, true);
  }
});
test("null exact values and aliases retain names without implicit date/number conversion", async () => {
  const plan = await compileSQLServerRead(
    "SELECT amount AS exact_amount FROM dbo.items",
  );
  const p = exactProjectionPlan(plan, { columns, rows: [schema.rows[0]] });
  assert.match(p.sql, /AS \[exact_amount\]/);
  validateExactResult(
    { columns: ["exact_amount"], rows: [{ exact_amount: null }] },
    p.columns,
  );
});
