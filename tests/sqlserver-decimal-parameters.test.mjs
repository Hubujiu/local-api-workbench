import test from "node:test";
import assert from "node:assert/strict";
import { compileSQLServerRead } from "../src/sqlserver-read-contract.mjs";
import { prepareSQLServerReadInput } from "../src/sqlserver-input-contract.mjs";
const sql = "SELECT id FROM dbo.items WHERE amount >= @p0 AND amount < @p0";
const decimal = (value, precision = 38, scale = 18) => ({
  type: "decimal",
  value,
  precision,
  scale,
});
test("decimal predicates use exact string binding and compiler-owned conversion", async () => {
  for (const p of [
    decimal("99999999999999999999.999999999999999999"),
    decimal("-0.000000000000000001"),
    decimal("0", 38, 38),
    decimal("9".repeat(38), 38, 0),
  ]) {
    const plan = await compileSQLServerRead(sql, [p]);
    assert.equal(
      plan.sql,
      `SELECT TOP (1001) [id] FROM [dbo].[items] WHERE ([amount] >= CONVERT(decimal(${p.precision},${p.scale}), @p0) AND [amount] < CONVERT(decimal(${p.precision},${p.scale}), @p0))`,
    );
    assert.deepEqual(plan.parameters, [
      { name: "p0", type: "NVarChar", value: p.value },
    ]);
  }
});
test("decimal rejects overflow, rounding, ambiguous syntax and hostile metadata before dispatch", async () => {
  for (const p of [
    decimal("1", 38, 38),
    decimal("1.001", 3, 2),
    decimal("10", 1, 0),
    decimal("9".repeat(39), 38, 0),
    decimal("1e3"),
    decimal(" 1"),
    decimal("+1"),
    decimal("01"),
    decimal(".1"),
    decimal("1."),
    decimal("1;DROP TABLE items"),
    decimal(1),
    decimal("1", 39, 0),
    decimal("1", 0, 0),
    decimal("1", 2, 3),
    decimal("1", 2, -1),
    decimal("1", 2.1, 0),
    decimal("1", "38", 0),
    { type: "decimal", value: "1" },
    { type: "int64", value: "1", precision: 20 },
    { ...decimal("1"), extra: true },
  ])
    await assert.rejects(compileSQLServerRead(sql, [p]));
  let reads = 0;
  const p = {
    ...decimal("1"),
    get scale() {
      reads++;
      return 1;
    },
  };
  await assert.rejects(compileSQLServerRead(sql, [p]));
  assert.equal(reads, 0);
});
test("flat input snapshots decimal before worker and never puts decimal text in SQL", async () => {
  const p = decimal("9007199254740993.123456789012345678");
  const pending = prepareSQLServerReadInput({
    type: "sqlserver",
    host: "fixture.invalid",
    user: "fixture",
    password: "",
    database: "fixture",
    ssl: true,
    sql,
    parameters: [p],
  });
  p.value = "0";
  p.precision = 1;
  const { plan } = await pending;
  assert.equal(plan.parameters[0].value, "9007199254740993.123456789012345678");
  assert.doesNotMatch(plan.sql, /9007199254740993/);
  assert.match(plan.sql, /decimal\(38,18\)/);
});
