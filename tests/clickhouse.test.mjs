import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { queryClickHouse, clickhouseRequest } from "../src/clickhouse.mjs";

test("ClickHouse uses readonly GET, typed escaped parameters and header-only credentials", async (t) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.test");
    assert.equal(req.method, "GET");
    assert.equal(url.searchParams.get("readonly"), "1");
    assert.equal(url.searchParams.get("param_p0"), "a\\tb\\nc\\\\N\\0\\b");
    assert.equal(url.searchParams.get("param_p1"), "\\N");
    assert.equal(url.searchParams.has("password"), false);
    assert.equal(
      req.headers.authorization,
      "Basic " + Buffer.from("tester:fixture-only").toString("base64"),
    );
    assert.match(url.searchParams.get("query"), /LIMIT 1001 FORMAT JSON$/);
    res.end(
      JSON.stringify({
        meta: [{ name: "value", type: "String" }],
        data: [{ value: "fixture" }],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const result = await queryClickHouse({
    host: "127.0.0.1",
    port: server.address().port,
    user: "tester",
    password: "fixture-only",
    sql: "SELECT {p0:String}",
    parameters: ["a\tb\nc\\N\0\b", null],
  });
  assert.deepEqual(result.rows, [{ value: "fixture" }]);
  const named = clickhouseRequest({
    sql: "SELECT {name:String}",
    parameters: { name: "'; DELETE FROM x; --" },
  });
  assert.equal(
    named.url.searchParams.get("param_name"),
    "'; DELETE FROM x; --",
  );
  for (const input of [
    { sql: "DELETE FROM x" },
    { sql: "SELECT 1; DROP TABLE x" },
    { sql: "SELECT 1", host: "evil.test/path" },
    { sql: "SELECT 1", parameters: [{}] },
    { sql: "SELECT 1", parameters: JSON.parse('{"__proto__":"x"}') },
  ])
    assert.throws(() => clickhouseRequest(input));
});
test("ClickHouse rejects redirects, malformed and oversized replies and truncates bounded rows", async (t) => {
  let mode = "rows";
  const server = http.createServer((req, res) => {
    if (mode === "redirect") {
      res.writeHead(302, { Location: "http://127.0.0.1:1/" });
      res.end();
    } else if (mode === "large") res.end("x".repeat(1024 * 1024 + 1));
    else if (mode === "invalid") res.end("not JSON");
    else if (mode === "exception") {
      res.setHeader("X-ClickHouse-Exception-Code", "123");
      res.end("fixture error");
    } else
      res.end(
        JSON.stringify({
          meta: [{ name: "n" }],
          data: Array.from({ length: 1001 }, (_, n) => ({ n })),
        }),
      );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const input = { port: server.address().port, sql: "SELECT 1" };
  const result = await queryClickHouse(input);
  assert.equal(result.rows.length, 1000);
  assert.equal(result.truncated, true);
  for (const value of ["redirect", "large", "invalid", "exception"]) {
    mode = value;
    await assert.rejects(queryClickHouse(input));
  }
});
test("ClickHouse TLS verifies server certificates and accepts only explicit trusted CA", async (t) => {
  const cert = await readFile(
      new URL("./fixtures/localhost.crt", import.meta.url),
    ),
    key = await readFile(new URL("./fixtures/localhost.key", import.meta.url));
  const server = https.createServer({ cert, key }, (_, res) =>
    res.end(JSON.stringify({ meta: [{ name: "n" }], data: [{ n: 1 }] })),
  );
  server.on("tlsClientError", () => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const input = {
    host: "127.0.0.1",
    port: server.address().port,
    ssl: true,
    sql: "SELECT 1",
  };
  await assert.rejects(queryClickHouse(input), /cert|self.signed|verify/i);
  assert.equal(
    (await queryClickHouse({ ...input, ca: cert.toString() })).rows[0].n,
    1,
  );
});
