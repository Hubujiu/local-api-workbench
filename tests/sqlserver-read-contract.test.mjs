import test from "node:test";
import assert from "node:assert/strict";
import { compileSQLServerRead as compile } from "../src/sqlserver-read-contract.mjs";
const query = "SELECT id FROM dbo.items WHERE id=@p0";
test("inert compiler regenerates bounded SELECT and preserves exact parameters", async () => {
  const p = await compile(
    "SELECT id, amount AS total FROM dbo.items WHERE id >= @p0 AND name = @p1 ORDER BY id DESC",
    [42, "雪💡'; DROP TABLE items;"],
  );
  assert.equal(
    p.sql,
    "SELECT TOP (1001) [id], [amount] AS [total] FROM [dbo].[items] WHERE ([id] >= @p0 AND [name] = @p1) ORDER BY [id] DESC",
  );
  assert.equal(p.parameters[1].value, "雪💡'; DROP TABLE items;");
  assert.equal(p.requiredDatabaseUpdateability, "READ_ONLY");
  for (const value of [
    "9223372036854775807",
    "-9223372036854775808",
    "9007199254740993",
  ]) {
    assert.deepEqual(
      (await compile(query, [{ type: "int64", value }])).parameters,
      [{ name: "p0", type: "BigInt", value }],
    );
  }
  for (const [value, type] of [
    [null, "NVarChar"],
    [true, "Bit"],
    [-2147483648, "Int"],
    [2147483647, "Int"],
    ["", "NVarChar"],
  ]) {
    assert.deepEqual((await compile(query, [value])).parameters, [
      { name: "p0", type, value },
    ]);
  }
});
test("rejects expressions, functions, cross database, dynamic SQL and unknown AST shapes", async () => {
  for (const sql of [
    "SELECT * FROM dbo.items",
    "SELECT id INTO dbo.copy FROM dbo.items",
    "SELECT id FROM dbo.items; DELETE FROM dbo.items",
    "WITH q AS (SELECT id FROM dbo.items) SELECT id FROM q",
    "SELECT dbo.fun() FROM dbo.items",
    "SELECT NEXT VALUE FOR dbo.seq FROM dbo.items",
    "SELECT id FROM other.dbo.items",
    "SELECT id FROM server.other.dbo.items",
    "SELECT id FROM dbo.items WITH (NOLOCK)",
    "SELECT id FROM dbo.items UNION SELECT id FROM dbo.other",
    "SELECT TOP 1 id FROM dbo.items",
    "SELECT DISTINCT id FROM dbo.items",
    "SELECT id FROM dbo.items WHERE id=1",
    "SELECT id FROM dbo.items WHERE id=@p0 OR id=@p1",
    "SELECT id FROM dbo.items; SELECT id FROM dbo.items",
    "SELECT id FROM dbo.items --comment",
    "SELECT [@p0] FROM dbo.items",
    "SELECT id, ID FROM dbo.items",
    "EXEC xp_cmdshell bad",
    "DROP TABLE dbo.items",
    "SELECT @x=id FROM dbo.items",
    "SELECT @@version FROM dbo.items",
    "SELECT id FROM OPENROWSET(foo)",
    "SELECT id FROM dbo.items FOR XML AUTO",
    "SELECT id FROM dbo.items OPTION RECOMPILE",
    "SELECT id FROM dbo.items JOIN dbo.other ON id=id",
    "SELECT id FROM dbo.items GROUP BY id",
    "SELECT id FROM dbo.items ORDER BY 1",
    "SELECT id FROM dbo.items WHERE id IN @p0",
    "SELECT id FROM dbo.items WHERE id=other",
    "SELECT id FROM dbo.items WHERE id=@p01",
  ])
    await assert.rejects(compile(sql), undefined, sql);
});
test("rejects inexact, malformed, oversized and hostile data without invoking user code", async () => {
  for (const value of [
    1.5,
    NaN,
    Infinity,
    2147483648,
    9007199254740992,
    undefined,
    1n,
    Symbol(),
    () => 0,
    new Date(),
    { type: "int64", value: "9223372036854775808" },
    { type: "int64", value: "-9223372036854775809" },
    { type: "int64", value: "01" },
    { type: "int64", value: 1 },
    { type: "int64", value: "1", extra: 0 },
    "\ud800",
    "\0",
    "雪".repeat(22000),
    { type: "int64", value: { deep: {} } },
  ])
    await assert.rejects(compile(query, [value]));
  await assert.rejects(compile(query));
  await assert.rejects(compile("SELECT id FROM dbo.items", [1]));
  await assert.rejects(compile(" ".repeat(8193)));
  await assert.rejects(compile(query, Array(65).fill(1)));
  await assert.rejects(compile(query, Array(64).fill("a".repeat(65536))));
  let called = 0;
  const getter = {
    get value() {
      called++;
      return "1";
    },
    type: "int64",
  };
  const array = [];
  Object.defineProperty(array, "0", {
    get() {
      called++;
      return 1;
    },
  });
  const proxy = new Proxy(
    {},
    {
      get() {
        called++;
        throw Error("trap");
      },
      getPrototypeOf() {
        called++;
        throw Error("trap");
      },
      ownKeys() {
        called++;
        throw Error("trap");
      },
    },
  );
  for (const value of [getter, proxy])
    await assert.rejects(compile(query, [value]));
  for (const values of [
    array,
    new Proxy([], {
      get() {
        called++;
        throw Error("trap");
      },
    }),
    [,],
    Object.assign([1], { extra: 1 }),
  ])
    await assert.rejects(compile(query, values));
  const { proxy: revoked, revoke } = Proxy.revocable({}, {});
  revoke();
  await assert.rejects(compile(query, [revoked]));
  assert.equal(called, 0);
});
test("input snapshots survive caller mutation and parser does not block event loop", async () => {
  const value = { type: "int64", value: "9007199254740993" };
  const values = [value];
  const pending = compile(query, values);
  value.value = "0";
  values[0] = 0;
  assert.equal((await pending).parameters[0].value, "9007199254740993");
  let ticked = false;
  const timer = setTimeout(() => {
    ticked = true;
  }, 0);
  await compile("SELECT id FROM dbo.items");
  clearTimeout(timer);
  assert.equal(ticked, true);
  await assert.rejects(
    compile(
      "SELECT id FROM dbo.items WHERE " +
        Array(100).fill("id=@p0").join(" AND "),
      [1],
    ),
  );
});
test("concurrent compiler work is bounded and capacity is released", async () => {
  const first = compile("SELECT id FROM dbo.items");
  const second = compile("SELECT id FROM dbo.items");
  await assert.rejects(compile("SELECT id FROM dbo.items"), /busy/);
  await Promise.all([first, second]);
  assert.equal((await compile("SELECT id FROM dbo.items")).limit, 1000);
});

test("real deadline terminates workers, drops late results and restores slots", async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const dir = await mkdtemp(join(tmpdir(), "sqlserver-contract-timeout-"));
  try {
    // Test a byte-for-byte production wrapper except for the worker URL.
    // No injection option or shorter timeout is exposed in the public API.
    const source = await readFile(
      new URL("../src/sqlserver-read-contract.mjs", import.meta.url),
      "utf8",
    );
    const target =
      'new URL("./sqlserver-read-contract-worker.mjs", import.meta.url)';
    assert.equal(
      source.split(target).length,
      2,
      "worker URL replacement must be unique",
    );
    const fixture = new URL(
      "./fixtures/sqlserver-contract-timeout-worker.mjs",
      import.meta.url,
    ).href;
    const modulePath = join(dir, "compiler.mjs");
    await writeFile(
      modulePath,
      source.replace(target, `new URL(${JSON.stringify(fixture)})`),
    );
    const { compileSQLServerRead: isolated } = await import(
      pathToFileURL(modulePath).href
    );
    const paths = [join(dir, "a.log"), join(dir, "b.log")];
    const started = performance.now();
    const pending = paths.map((path) => isolated("hang", [path]));
    await assert.rejects(isolated("other"), /busy/);
    await Promise.all(
      pending.map((p) => assert.rejects(p, /deadline exceeded/)),
    );
    assert(performance.now() - started >= 1900);
    const stopped = await Promise.all(
      paths.map((path) => readFile(path, "utf8")),
    );
    for (const log of stopped) assert.match(log, /started\ntick/);
    assert.equal(await isolated("other"), "capacity restored");
    // Past the fixture's delayed-result deadline, no heartbeat or late result
    // can occur: terminate() was awaited before rejecting/releasing each slot.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(
      await Promise.all(paths.map((path) => readFile(path, "utf8"))),
      stopped,
    );
    assert(stopped.every((log) => !log.includes("late")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
