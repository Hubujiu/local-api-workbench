import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { clickhouseRequest, queryClickHouse } from "../src/clickhouse.mjs";
import { queryRemoteDatabase } from "../src/remote-database.mjs";

const base = {
  type: "clickhouse",
  host: "127.0.0.1",
  port: 1,
  sql: "SELECT 1",
};
const invalid = (char) => [
  { sql: `SELECT 'private-${char}'` },
  { database: `private-${char}` },
  { database: [`private-${char}`] },
  { user: `private-${char}` },
  { password: `private-${char}` },
  { parameters: [`private-${char}`] },
  { parameters: { named: `private-${char}` } },
];
const sanitized = (error) => {
  assert.match(error.message, /ClickHouse/);
  assert.equal(error.message.includes("private-"), false);
  assert.equal(error.message.includes("\ud800"), false);
  assert.equal(error.message.includes("\udfff"), false);
  return true;
};

test("ClickHouse malformed SQL, database, credentials and bound strings reject before HTTP or HTTPS construction", async (t) => {
  let attempts = 0;
  const trap = () => {
    attempts++;
    throw Error("unexpected transport");
  };
  t.mock.method(http, "request", trap);
  t.mock.method(https, "request", trap);
  for (const ssl of [false, true])
    for (const char of ["\ud800", "\udfff"])
      for (const bad of invalid(char)) {
        const input = { ...base, ssl, ...bad };
        assert.throws(() => clickhouseRequest(input), sanitized);
        await assert.rejects(queryClickHouse(input), sanitized);
        await assert.rejects(queryRemoteDatabase(input), sanitized);
      }
  // ClickHouse is not an SSH-capable remote provider; malformed and otherwise
  // valid input must not fall back to direct HTTP or HTTPS transport.
  for (const sql of ["SELECT 1", "SELECT '\ud800'"])
    await assert.rejects(
      queryRemoteDatabase({ ...base, sql, ssh: { host: "fixture.invalid" } }),
      /SSH/,
    );
  assert.equal(attempts, 0);
});

test("ClickHouse actual HTTP wire keeps legal Unicode, escaping, Basic credentials and read-only GET unchanged", async (t) => {
  const seen = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    seen.push({
      method: request.method,
      query: url.searchParams.get("query"),
      database: url.searchParams.get("database"),
      parameter: url.searchParams.get("param_named"),
      credentials: Buffer.from(
        request.headers.authorization.slice(6),
        "base64",
      ).toString(),
    });
    response.end(
      JSON.stringify({
        meta: [{ name: "value", type: "String" }],
        data: [{ value: "fixture" }],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const sql = "SELECT '中文🙂�', {named:String}";
  for (const query of [queryClickHouse, queryRemoteDatabase]) {
    const result = await query({
      ...base,
      port: server.address().port,
      sql,
      database: "数据库🙂�",
      user: "用户🙂�",
      password: "密码🙂�",
      parameters: { named: "中文🙂�\t\n\u0000\\" },
    });
    assert.deepEqual(result.rows, [{ value: "fixture" }]);
    assert.deepEqual(seen.at(-1), {
      method: "GET",
      query: `SELECT * FROM (${sql}) AS localapi_result LIMIT 1001 FORMAT JSON`,
      database: "数据库🙂�",
      parameter: "中文🙂�\\t\\n\\0\\\\",
      credentials: "用户🙂�:密码🙂�",
    });
  }
});

test("ClickHouse existing empty fields, scalar parameters, SQL subset and bounds remain unchanged", () => {
  for (const options of [{}, { user: "", password: "", database: "" }]) {
    const request = clickhouseRequest({ ...base, ...options });
    assert.equal(
      Buffer.from(request.headers.Authorization.slice(6), "base64").toString(),
      "default:",
    );
    assert.equal(request.url.searchParams.has("database"), false);
  }
  assert.equal(
    clickhouseRequest({ ...base, database: ["fixture"] }).url.searchParams.get(
      "database",
    ),
    "fixture",
  );
  const request = clickhouseRequest({
    ...base,
    parameters: [null, false, 1.25, "", "�"],
  });
  assert.deepEqual(
    Array.from({ length: 5 }, (_, i) =>
      request.url.searchParams.get(`param_p${i}`),
    ),
    ["\\N", "false", "1.25", "", "�"],
  );
  for (const sql of [
    "INSERT INTO items VALUES (1)",
    "DELETE FROM items",
    "UPDATE items SET x=1",
    "SELECT 1; SELECT 2",
    "SELECT 1 SETTINGS readonly=0",
    "SELECT '" + "x".repeat(50000) + "'",
  ])
    assert.throws(() => clickhouseRequest({ ...base, sql }), /ClickHouse/);
  assert.throws(
    () => clickhouseRequest({ ...base, parameters: Array(1001).fill(1) }),
    /1000/,
  );
  assert.throws(
    () =>
      clickhouseRequest({ ...base, parameters: { named: "x".repeat(262144) } }),
    /256KiB/,
  );
});
