import test from "node:test";
import assert from "node:assert/strict";
import {
  compileSQLServerRead as compile,
  sqlServerConnectionContract as config,
  sqlServerResultTypeAllowed as type,
} from "../src/sqlserver-read-contract.mjs";
test("SQLServer WIP reconstructs one parameterized SELECT without driver/network", () => {
  const p = compile(
    "SELECT id, amount AS total FROM dbo.items WHERE id >= @p0 AND name = @p1 ORDER BY id DESC",
    [42, "雪'; DROP TABLE items;"],
  );
  assert.equal(
    p.sql,
    "SELECT TOP (1001) [id], [amount] AS [total] FROM [dbo].[items] WHERE ([id] >= @p0 AND [name] = @p1) ORDER BY [id] DESC",
  );
  assert.equal(p.parameters[1].value, "雪'; DROP TABLE items;");
  assert(!p.sql.includes("DROP"));
  assert.equal(p.requiredDatabaseUpdateability, "READ_ONLY");
  assert.equal(
    compile("SELECT id FROM dbo.items WHERE id=@p0", [
      { type: "int64", value: "9223372036854775807" },
    ]).parameters[0].value,
    "9223372036854775807",
  );
});
test("SQLServer WIP rejects arbitrary TSQL, hidden AST options and inexact parameters", () => {
  for (const sql of [
    "SELECT * FROM dbo.items",
    "SELECT id INTO dbo.copy FROM dbo.items",
    "SELECT id FROM dbo.items; DELETE FROM dbo.items",
    "WITH q AS (SELECT id FROM dbo.items) SELECT id FROM q",
    "SELECT dbo.fun() FROM dbo.items",
    "SELECT id FROM other.dbo.items",
    "SELECT id FROM dbo.items WITH (NOLOCK)",
    "SELECT id FROM dbo.items UNION SELECT id FROM dbo.other",
    "SELECT TOP 1 id FROM dbo.items",
    "SELECT id FROM dbo.items WHERE id=1",
    "SELECT id FROM dbo.items WHERE id=@p0 OR id=@p1",
    "SELECT id FROM dbo.items; SELECT id FROM dbo.items",
    "SELECT id FROM dbo.items --comment",
    "SELECT [@p0] FROM dbo.items",
    "SELECT id, ID FROM dbo.items",
    "EXEC xp_cmdshell 'bad'",
  ])
    assert.throws(() => compile(sql));
  assert.throws(() => compile("SELECT id FROM dbo.items WHERE id=@p0"));
  for (const value of [
    1.5,
    NaN,
    Infinity,
    9007199254740992,
    { type: "int64", value: "9223372036854775808" },
    new Date(),
    () => 0,
  ])
    assert.throws(() =>
      compile("SELECT id FROM dbo.items WHERE id=@p0", [value]),
    );
  assert.throws(() => compile("SELECT id FROM dbo.items", [1]));
  let called = 0;
  const a = [];
  Object.defineProperty(a, 0, {
    get() {
      called++;
      return 1;
    },
    enumerable: true,
  });
  assert.throws(() => compile("SELECT id FROM dbo.items WHERE id=@p0", a));
  assert.equal(called, 0);
});
test("SQLServer WIP explicit credentials and verified TLS cannot be widened", () => {
  const input = {
    host: "localhost",
    database: "fixture",
    user: "fictional",
    password: "",
    ssl: true,
  };
  const c = config(input);
  assert.equal(c.authentication.options.password, "");
  assert.equal(c.options.encrypt, true);
  assert.equal(c.options.trustServerCertificate, false);
  assert.equal(c.options.maxRetriesOnTransientErrors, 0);
  for (const patch of [
    { password: undefined },
    { ssl: false },
    { trustServerCertificate: true },
    { authentication: { type: "azure-active-directory-default" } },
    { port: 0 },
    { ca: "" },
    { database: "" },
  ])
    assert.throws(() => config({ ...input, ...patch }));
  let called = 0;
  const x = { ...input };
  Object.defineProperty(x, "password", {
    get() {
      called++;
      return "secret";
    },
    enumerable: true,
  });
  assert.throws(() => config(x));
  assert.equal(called, 0);
  for (const t of [
    "DecimalN",
    "NumericN",
    "Money",
    "SmallMoney",
    "DateTime2",
    "DateTimeOffset",
    "Time",
    "Date",
    "Variant",
    "UDT",
    "Xml",
    "Float",
  ])
    assert.throws(() => type(t));
  for (const t of ["BigInt", "Int", "NVarChar", "VarBinary"])
    assert.equal(type(t), true);
});
