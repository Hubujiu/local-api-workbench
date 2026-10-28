import test from "node:test";
import assert from "node:assert/strict";
import { oracleReadInput } from "../src/oracle-read-config.mjs";
import {
  oracleBindParameters,
  oracleReadFetchType,
  oracleReadColumns,
  oracleReadRow,
} from "../src/oracle-read-values.mjs";

const driver = Object.freeze(
  Object.fromEntries(
    [
      "BIND_IN",
      "DB_TYPE_NUMBER",
      "DB_TYPE_CHAR",
      "DB_TYPE_VARCHAR",
      "DB_TYPE_NCHAR",
      "DB_TYPE_NVARCHAR",
      "DB_TYPE_RAW",
      "DB_TYPE_CLOB",
      "DB_TYPE_LONG",
      "DB_TYPE_DATE",
      "DB_TYPE_JSON",
      "DB_TYPE_OBJECT",
      "DB_TYPE_VECTOR",
    ].map((name) => [name, Object.freeze({ name })]),
  ),
);
const input = (patch = {}) => ({
  host: "db.example.test",
  port: 1521,
  service: "FREEPDB1.example.test",
  user: "reader",
  password: "request-only secret",
  ssl: true,
  sql: "SELECT :1 AS value FROM dual",
  parameters: [1],
  ...patch,
});
const meta = (dbType, name = "VALUE", patch = {}) => ({
  name,
  dbType,
  ...patch,
});

test("Oracle WIP uses only explicit TCPS connection identity", () => {
  const value = oracleReadInput(input());
  assert.deepEqual(value.connectionOptions, {
    connectString: "tcps://db.example.test:1521/FREEPDB1.example.test",
    user: "reader",
    password: "request-only secret",
    externalAuth: false,
    retryCount: 0,
    connectTimeout: 3,
    transportConnectTimeout: 3,
    sslServerDNMatch: true,
    sslAllowWeakDNMatch: false,
  });
  assert.equal(value.sql, input().sql);
  assert.deepEqual(value.binds, [1]);
  assert.match(
    oracleReadInput(input({ host: "2001:db8::1" })).connectionOptions
      .connectString,
    /^tcps:\/\/\[2001:db8::1\]:1521\//,
  );
  assert.match(
    oracleReadInput(input({ host: "127.0.0.1" })).connectionOptions
      .connectString,
    /^tcps:\/\/127\.0\.0\.1:1521\//,
  );
});

test("Oracle WIP rejects omitted and unsupported connection settings", () => {
  for (const key of [
    "host",
    "port",
    "service",
    "user",
    "password",
    "ssl",
    "sql",
  ]) {
    const value = input();
    delete value[key];
    assert.throws(() => oracleReadInput(value), undefined, key);
  }
  for (const patch of [
    { ssl: false },
    { ssl: "true" },
    { ca: "certificate" },
    { walletContent: "secret" },
    { walletLocation: "/tmp/wallet" },
    { configDir: "/tmp/config" },
    { connectString: "anything" },
    { externalAuth: true },
    { privilege: "SYSDBA" },
    { accessToken: "secret" },
    { ssh: {} },
    { type: "oracle" },
    { sslServerDNMatch: false },
    { sslAllowWeakDNMatch: true },
  ]) {
    assert.throws(
      () => oracleReadInput(input(patch)),
      undefined,
      JSON.stringify(patch),
    );
  }
});

test("Oracle WIP accepts atoms, not descriptors, aliases or proxy users", () => {
  for (const host of [
    "",
    " db.test",
    "db.test ",
    "db/test",
    "db:1521",
    "tcp://db",
    "db?x=1",
    "db,other",
    "(HOST=db)",
    "db\0test",
    "db\ud800",
    "-db.test",
    "db..test",
    "[::1]",
    "fe80::1%eth0",
  ]) {
    assert.throws(() => oracleReadInput(input({ host })), undefined, host);
  }
  for (const service of [
    "",
    "svc/other",
    "svc?retry_count=2",
    "(SERVICE_NAME=svc)",
    "svc\0",
    "svc\ud800",
    "svc name",
  ]) {
    assert.throws(
      () => oracleReadInput(input({ service })),
      undefined,
      service,
    );
  }
  for (const user of [
    "",
    "SYS",
    "sys",
    "SYSTEM",
    "proxy[reader]",
    '"SYS"',
    "reader as sysdba",
    "reader\0",
  ]) {
    assert.throws(() => oracleReadInput(input({ user })), undefined, user);
  }
  for (const port of [0, -1, 65536, 1521.5, "1521", null, NaN]) {
    assert.throws(() => oracleReadInput(input({ port })));
  }
  for (const password of ["", "secret\0", "\ud800", "x".repeat(65537)]) {
    assert.throws(() => oracleReadInput(input({ password })));
  }
});

test("Oracle WIP SQL validation is bounded, not a homemade SQL classifier", () => {
  for (const sql of [
    "",
    " ",
    "x".repeat(50001),
    "SELECT '\ud800' FROM dual",
    "SELECT\0 1 FROM dual",
  ]) {
    assert.throws(() => oracleReadInput(input({ sql })));
  }
  // Classification is the execution layer's public getStatementInfo contract.
  assert.equal(
    oracleReadInput(input({ sql: "DELETE FROM t" })).sql,
    "DELETE FROM t",
  );
  assert.equal(
    oracleReadInput(input({ sql: "/* comment */ SELECT 'a;b' FROM dual" })).sql,
    "/* comment */ SELECT 'a;b' FROM dual",
  );
});

test("Oracle WIP normalizes only finite scalar, int64 and RAW input", () => {
  const values = [
    null,
    "text",
    1,
    0.5,
    { type: "int64", value: "9223372036854775807" },
    { type: "blob", base64: "AAH/" },
  ];
  const normalized = oracleReadInput(input({ parameters: values })).binds;
  assert.deepEqual(normalized, [
    null,
    "text",
    1,
    0.5,
    9223372036854775807n,
    Buffer.from([0, 1, 255]),
  ]);
  assert.deepEqual(oracleBindParameters(normalized, driver), [
    { dir: driver.BIND_IN, type: driver.DB_TYPE_VARCHAR, val: null },
    { dir: driver.BIND_IN, type: driver.DB_TYPE_VARCHAR, val: "text" },
    { dir: driver.BIND_IN, type: driver.DB_TYPE_NUMBER, val: 1 },
    { dir: driver.BIND_IN, type: driver.DB_TYPE_NUMBER, val: 0.5 },
    {
      dir: driver.BIND_IN,
      type: driver.DB_TYPE_NUMBER,
      val: 9223372036854775807n,
    },
    {
      dir: driver.BIND_IN,
      type: driver.DB_TYPE_RAW,
      val: Buffer.from([0, 1, 255]),
    },
  ]);
});

test("Oracle WIP never forwards user bind instructions or unsupported values", () => {
  for (const value of [
    true,
    false,
    {},
    [],
    { dir: "OUT", val: "x", type: "NUMBER" },
    { type: "blob", base64: "Zg" },
    { type: "blob", base64: "Zg==", dir: "OUT" },
    { type: "int64", value: "9223372036854775808" },
    undefined,
    NaN,
    Infinity,
    9007199254740992,
    "\ud800",
  ]) {
    assert.throws(() => oracleReadInput(input({ parameters: [value] })));
  }
  assert.throws(() =>
    oracleReadInput(input({ parameters: new Array(1001).fill(null) })),
  );
  assert.throws(() =>
    oracleReadInput(input({ parameters: ["x".repeat(1024 * 1024)] })),
  );
  assert.throws(() => oracleBindParameters([{ dir: "OUT", val: 1 }], driver));
  assert.throws(() => oracleBindParameters([1n << 64n], driver));
});

test("Oracle WIP rejects accessors and non-plain input rather than invoking them", () => {
  let reads = 0;
  const value = input();
  Object.defineProperty(value, "host", {
    get() {
      reads++;
      return "db.test";
    },
  });
  assert.throws(() => oracleReadInput(value));
  assert.equal(reads, 0);
  assert.throws(() => oracleReadInput(Object.create(input())));
});

test("Oracle WIP NUMBER fetch converts to text without a numeric converter", () => {
  assert.deepEqual(oracleReadFetchType(meta(driver.DB_TYPE_NUMBER), driver), {
    type: driver.DB_TYPE_VARCHAR,
  });
  for (const type of [
    "DB_TYPE_CHAR",
    "DB_TYPE_VARCHAR",
    "DB_TYPE_NCHAR",
    "DB_TYPE_NVARCHAR",
    "DB_TYPE_RAW",
  ]) {
    assert.equal(oracleReadFetchType(meta(driver[type]), driver), undefined);
  }
  for (const type of [
    "DB_TYPE_CLOB",
    "DB_TYPE_LONG",
    "DB_TYPE_DATE",
    "DB_TYPE_JSON",
    "DB_TYPE_OBJECT",
    "DB_TYPE_VECTOR",
  ]) {
    assert.throws(() => oracleReadFetchType(meta(driver[type]), driver));
  }
  assert.throws(() => oracleReadFetchType({}, driver));
  assert.throws(() =>
    oracleReadFetchType(
      meta(driver.DB_TYPE_VARCHAR, "V", { isJson: true }),
      driver,
    ),
  );
  assert.throws(() =>
    oracleReadFetchType(
      meta(driver.DB_TYPE_VARCHAR, "V", { isOson: true }),
      driver,
    ),
  );
});

test("Oracle WIP checks result metadata before fetching", () => {
  assert.deepEqual(
    oracleReadColumns(
      [meta(driver.DB_TYPE_NUMBER, "N"), meta(driver.DB_TYPE_RAW, "B")],
      driver,
    ),
    ["N", "B"],
  );
  for (const metadata of [
    null,
    [],
    new Array(1),
    Array.from({ length: 129 }, (_, i) => meta(driver.DB_TYPE_NUMBER, "N" + i)),
    [meta(driver.DB_TYPE_NUMBER), meta(driver.DB_TYPE_VARCHAR)],
    [meta(driver.DB_TYPE_CLOB)],
    [meta(driver.DB_TYPE_VARCHAR, "x\ud800")],
    [meta(driver.DB_TYPE_VARCHAR, "X", { byteSize: 1024 * 1024 + 1 })],
  ]) {
    assert.throws(() => oracleReadColumns(metadata, driver));
  }
});

test("Oracle WIP returns exact NUMBER strings and bounded scalar rows", () => {
  const metadata = [
    meta(driver.DB_TYPE_NUMBER, "N"),
    meta(driver.DB_TYPE_VARCHAR, "S"),
    meta(driver.DB_TYPE_RAW, "B"),
  ];
  assert.deepEqual(
    oracleReadRow(
      ["123456789012345678901234567890.125", "text", Buffer.from([0, 255])],
      metadata,
      driver,
    ),
    {
      N: "123456789012345678901234567890.125",
      S: "text",
      B: { type: "blob", base64: "AP8=" },
    },
  );
  assert.deepEqual(oracleReadRow([null, null, null], metadata, driver), {
    N: null,
    S: null,
    B: null,
  });
  assert.deepEqual(
    oracleReadRow(["1.25E+30", "", new Uint8Array()], metadata, driver),
    { N: "1.25E+30", S: "", B: { type: "blob", base64: "" } },
  );
  for (const row of [
    [1, "text", Buffer.alloc(0)],
    ["NaN", "text", Buffer.alloc(0)],
    ["1", {}, Buffer.alloc(0)],
    ["1", "text", {}],
    ["1", "text"],
    ["1", "\ud800", Buffer.alloc(0)],
  ]) {
    assert.throws(() => oracleReadRow(row, metadata, driver));
  }
  assert.throws(() =>
    oracleReadRow(
      ["x".repeat(1024 * 1024)],
      [meta(driver.DB_TYPE_VARCHAR)],
      driver,
    ),
  );
});
