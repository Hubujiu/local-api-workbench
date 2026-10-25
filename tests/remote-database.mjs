import assert from "node:assert/strict";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
const common = {
  host: "127.0.0.1",
  user: "tester",
  password: "local-fixture-only",
  database: "fixture",
};
const pg = await queryRemoteDatabase({
  ...common,
  type: "postgres",
  port: 5432,
  sql: "SELECT $1::int AS answer",
  parameters: [42],
});
assert.equal(pg.rows[0].answer, 42);
const mysql = await queryRemoteDatabase({
  ...common,
  type: "mysql",
  port: 3306,
  sql: "SELECT ? AS answer",
  parameters: [42],
});
assert.equal(mysql.rows[0].answer, 42);
await assert.rejects(
  queryRemoteDatabase({
    ...common,
    type: "postgres",
    sql: "DELETE FROM anything",
  }),
  /SELECT/,
);
await assert.rejects(
  queryRemoteDatabase({ ...common, type: "mysql", sql: "DROP TABLE anything" }),
  /SELECT/,
);
const limited = await queryRemoteDatabase({
  ...common,
  type: "postgres",
  sql: "SELECT generate_series(1,2000) AS number",
});
assert.equal(limited.rows.length, 1000);
assert.equal(limited.truncated, true);

// Dedicated disposable CI service, never a user database.
const { Client } = await import("pg");
const { createApp } = await import("../src/server.mjs");
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const root = await mkdtemp(join(tmpdir(), "pg-write-http-"));
let app;
const setup = new Client({ ...common, port: 5432 });
const table = "localapi_write_" + process.pid;
await setup.connect();
try {
  await setup.query(
    `CREATE TABLE ${table}(id integer PRIMARY KEY, value text)`,
  );
  app = await createApp({ root, port: 0 });
  const project = await app.store.create("PostgreSQL disposable fixture");
  const endpoint = app.url + "/api/projects/" + project.id + "/database";
  const headers = {
    "content-type": "application/json",
    "x-local-token": app.token,
  };
  const write = async (sql, parameters = []) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...common,
        type: "postgres",
        allowWrite: true,
        sql,
        parameters,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    return result;
  };
  const denied = {
    ...common,
    type: "postgres",
    sql: `INSERT INTO ${table} VALUES (99, 'denied')`,
  };
  for (const request of [
    { headers, body: denied },
    {
      headers: { "content-type": "application/json" },
      body: { ...denied, allowWrite: true },
    },
    {
      headers: { ...headers, Origin: "https://untrusted.example" },
      body: { ...denied, allowWrite: true },
    },
  ]) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
    assert.equal(response.ok, false);
  }
  const count = async () =>
    Number((await setup.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const inserted = await write(`INSERT INTO "${table}" VALUES ($1, $2)`, [
    1,
    "literal ) -- /* RETURNING",
  ]);
  assert.equal(inserted.committed, true);
  assert.equal(inserted.affectedRows, 1);
  assert.equal(await count(), 1);
  await assert.rejects(
    queryRemoteDatabase({
      ...common,
      type: "postgres",
      sql: `SELECT 1) AS escaped; COMMIT; DELETE FROM ${table}; SELECT 1 --`,
    }),
    /multiple commands|prepared statement/i,
  );
  assert.equal(
    await count(),
    1,
    "read-only query cannot end its transaction through a SQL batch",
  );

  await assert.rejects(
    write(`INSERT INTO ${table} SELECT generate_series(100,1100), 'overflow'`),
    /1000/,
  );
  assert.equal(await count(), 1, "overflow is rolled back on the real service");
  await assert.rejects(
    write(
      `INSERT INTO ${table} VALUES (2, 'escape')) SELECT '0' AS affected_rows --`,
    ),
  );
  await assert.rejects(write(`DELETE FROM ${table}; DROP TABLE ${table}`));
  assert.equal(await count(), 1, "escaped and batched SQL did not mutate data");
  const updated = await write(`UPDATE ${table} SET value = $1 WHERE id = $2`, [
    "updated",
    1,
  ]);
  assert.equal(updated.affectedRows, 1);
  assert.equal(
    (await setup.query(`SELECT value FROM ${table} WHERE id = 1`)).rows[0]
      .value,
    "updated",
  );
  assert.equal(
    (await write(`DELETE FROM ${table} WHERE id = $1`, [1])).affectedRows,
    1,
  );
  assert.equal(
    (
      await write(
        `INSERT INTO ${table} SELECT generate_series(1,1000), 'boundary'`,
      )
    ).affectedRows,
    1000,
  );
  assert.equal((await write(`DELETE FROM ${table}`)).affectedRows, 1000);
  assert.equal(await count(), 0);
} finally {
  if (app) await new Promise((resolve) => app.server.close(resolve));
  await rm(root, { recursive: true, force: true });
  try {
    await setup.query(`DROP TABLE IF EXISTS ${table}`);
  } finally {
    await setup.end();
  }
}
console.log("REAL_DATABASE_FIXTURES_PASS");

// Real-service value fidelity, not just successful connection or row counts.
const exactParameters = [
  { type: "int64", value: "9007199254740993" },
  "123456789012345678.123456789012",
  { type: "blob", base64: "AAH/" },
];
const pgValues = await queryRemoteDatabase({
  ...common,
  type: "postgres",
  port: 5432,
  sql: `SELECT $1::bigint AS wide, $2::numeric(30,12) AS precise, $3::bytea AS payload,
    TIMESTAMP '2026-10-24 12:34:56.123456' AS moment, DATE '2026-10-24' AS day,
    '{"id":9007199254740993,"small":7}'::jsonb AS document,
    ARRAY[1.234567890123456789::numeric] AS decimals`,
  parameters: exactParameters,
});
assert.equal(pgValues.rows[0].wide, "9007199254740993");
assert.equal(pgValues.rows[0].precise, "123456789012345678.123456789012");
assert.deepEqual(pgValues.rows[0].payload, { type: "blob", base64: "AAH/" });
assert.equal(pgValues.rows[0].moment, "2026-10-24 12:34:56.123456");
assert.equal(pgValues.rows[0].day, "2026-10-24");
assert.deepEqual(pgValues.rows[0].document, {
  id: "9007199254740993",
  small: 7,
});
assert.deepEqual(pgValues.rows[0].decimals, ["1.234567890123456789"]);
const mysqlValues = await queryRemoteDatabase({
  ...common,
  type: "mysql",
  port: 3306,
  sql: `SELECT CAST(? AS SIGNED) AS wide, CAST(? AS DECIMAL(30,12)) AS precise,
    CAST(? AS BINARY) AS payload, CAST('2026-10-24 12:34:56.123456' AS DATETIME(6)) AS moment,
    CAST('2026-10-24' AS DATE) AS day, CAST('{"id":9007199254740993,"small":7}' AS JSON) AS document,
    CAST('18446744073709551615' AS UNSIGNED) AS unsigned_wide`,
  parameters: exactParameters,
});
assert.equal(mysqlValues.rows[0].wide, "9007199254740993");
assert.equal(mysqlValues.rows[0].precise, "123456789012345678.123456789012");
assert.deepEqual(mysqlValues.rows[0].payload, { type: "blob", base64: "AAH/" });
assert.equal(mysqlValues.rows[0].moment, "2026-10-24 12:34:56.123456");
assert.equal(mysqlValues.rows[0].day, "2026-10-24");
assert.deepEqual(mysqlValues.rows[0].document, {
  id: "9007199254740993",
  small: 7,
});
assert.equal(mysqlValues.rows[0].unsigned_wide, "18446744073709551615");
for (const type of ["postgres", "mysql"]) {
  await assert.rejects(
    queryRemoteDatabase({
      ...common,
      type,
      sql: "SELECT 1 AS duplicate, 2 AS duplicate",
    }),
    /重复列/,
  );
  if (type === "mysql") {
    const prototype = Object.getOwnPropertyNames(Object.prototype);
    await assert.rejects(
      queryRemoteDatabase({ ...common, type, sql: "SELECT 1 AS __proto__" }),
      /field name \(__proto__\).*private property/,
    );
    assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), prototype);
  } else {
    const special = await queryRemoteDatabase({
      ...common,
      type,
      sql: "SELECT 1 AS __proto__",
    });
    assert.equal(Object.hasOwn(special.rows[0], "__proto__"), true);
    assert.equal(special.rows[0].__proto__, 1);
    assert.equal(Object.getPrototypeOf(special.rows[0]), Object.prototype);
  }
}
assert.deepEqual(JSON.parse(JSON.stringify(pgValues)), pgValues);
assert.deepEqual(JSON.parse(JSON.stringify(mysqlValues)), mysqlValues);
console.log(
  "PostgreSQL/MySQL exact integer, decimal, binary, temporal and JSON value contracts passed",
);

const typesSetup = new Client({ ...common, port: 5432 });
await typesSetup.connect();
const typedTable = "localapi_values_" + process.pid;
try {
  await typesSetup.query(
    `CREATE TABLE ${typedTable}(wide bigint, payload bytea)`,
  );
  const { mutatePostgres } = await import("../src/postgres-write.mjs");
  const write = await mutatePostgres({
    ...common,
    type: "postgres",
    allowWrite: true,
    sql: `INSERT INTO ${typedTable}(wide,payload) VALUES($1,$2)`,
    parameters: [exactParameters[0], exactParameters[2]],
  });
  assert.equal(write.committed, true);
  const restored = await queryRemoteDatabase({
    ...common,
    type: "postgres",
    sql: `SELECT * FROM ${typedTable}`,
  });
  assert.deepEqual(restored.rows, [
    { wide: "9007199254740993", payload: { type: "blob", base64: "AAH/" } },
  ]);
} finally {
  await typesSetup.query(`DROP TABLE IF EXISTS ${typedTable}`);
  await typesSetup.end();
}

const { verifySSHDatabaseFlows } = await import(
  "./ssh-database-integration.mjs"
);
await verifySSHDatabaseFlows(common);

const { verifyMySQLWrites } = await import("./mysql-write-integration.mjs");
await verifyMySQLWrites(common);

// Same mixed script/database/real HTTP contract against both real SQL engines.
const { verifyNativeDatabaseFlow } = await import(
  "./native-database-integration.mjs"
);
await verifyNativeDatabaseFlow({ ...common, type: "postgres", port: 5432 });
await verifyNativeDatabaseFlow({ ...common, type: "mysql", port: 3306 });
