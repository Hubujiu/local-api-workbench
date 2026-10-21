import assert from "node:assert/strict";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
const base = {
  type: "clickhouse",
  host: "127.0.0.1",
  port: 8123,
  user: "tester",
  password: "local-fixture-only",
  database: "fixture",
};
const value = "quote';semi;tab\tline\nslash\\N\0";
const result = await queryRemoteDatabase({
  ...base,
  sql: "SELECT {p0:String} AS value, {p1:UInt64} AS large, {p2:Nullable(String)} AS missing",
  parameters: [value, "18446744073709551615", null],
});
assert.equal(result.rows[0].value, value);
assert.equal(result.rows[0].large, "18446744073709551615");
assert.equal(result.rows[0].missing, null);
const named = await queryRemoteDatabase({
  ...base,
  sql: "SELECT {answer:UInt32} AS answer",
  parameters: { answer: 42 },
});
assert.equal(named.rows[0].answer, 42);
const limited = await queryRemoteDatabase({
  ...base,
  sql: "SELECT number FROM numbers(2000)",
});
assert.equal(limited.rows.length, 1000);
assert.equal(limited.truncated, true);
await assert.rejects(
  queryRemoteDatabase({ ...base, sql: "DELETE FROM fixture.items" }),
  /SELECT/,
);
const url = new URL("http://127.0.0.1:8123/");
url.searchParams.set(
  "query",
  "CREATE TABLE fixture.forbidden_by_get(n UInt8) ENGINE Memory",
);
const denied = await fetch(url, {
  headers: {
    Authorization:
      "Basic " + Buffer.from("tester:local-fixture-only").toString("base64"),
  },
});
assert.equal(
  denied.ok,
  false,
  "server must enforce readonly GET even for an otherwise privileged fixture user",
);
const absent = await queryRemoteDatabase({
  ...base,
  sql: "SELECT count() AS n FROM system.tables WHERE database='fixture' AND name='forbidden_by_get'",
});
assert.equal(absent.rows[0].n, "0");

await assert.rejects(
  queryRemoteDatabase({ ...base, sql: "SELECT 1 SETTINGS readonly=0" }),
  /ClickHouse/,
);
console.log("REAL_CLICKHOUSE_FIXTURE_PASS");
