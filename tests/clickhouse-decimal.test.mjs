import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { queryClickHouse } from "../src/clickhouse.mjs";

// Small simulated HTTP protocol fixtures only, not real database acceptance.
test("ClickHouse Decimal quotes are mandatory and unsupported settings never fall back", async (t) => {
  let body;
  let status = 200;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    const url = new URL(req.url, "http://fixture.test");
    assert.equal(req.method, "GET");
    assert.equal(
      url.searchParams.get("output_format_json_quote_decimals"),
      "1",
    );
    assert.equal(
      url.searchParams.get("output_format_json_quote_64bit_integers"),
      "1",
    );
    res.writeHead(status);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const input = {
    host: "127.0.0.1",
    port: server.address().port,
    sql: "SELECT 1",
  };
  const reply = (type, value) =>
    JSON.stringify({ meta: [{ name: "d", type }], data: [{ d: value }] });
  for (const [type, value] of [
    ["Decimal(38, 19)", "0.1234567890123456789"],
    ["Decimal32(2)", "-1234567.89"],
    ["Decimal64(9)", "123456789.123456789"],
    ["Decimal128(19)", "-1234567890123456789.1234567890123456789"],
    [
      "Decimal256(38)",
      "12345678901234567890123456789012345678.12345678901234567890123456789012345678",
    ],
    ["Decimal(1, 1)", "0.0"],
    ["Nullable(Decimal(9, 2))", null],
    ["LowCardinality(Nullable(Decimal(9, 2)))", "-1.25"],
    ["Array(Array(Nullable(Decimal(18, 9))))", [["0.123456789", null], []]],
  ]) {
    body = reply(type, value);
    assert.deepEqual((await queryClickHouse(input)).rows, [{ d: value }]);
  }
  // Prior adapter returned 0.12345678901234568 for this exact raw JSON.
  body =
    '{"meta":[{"name":"d","type":"Decimal(38, 19)"}],"data":[{"d":0.1234567890123456789}]}';
  await assert.rejects(queryClickHouse(input), /Decimal必须/);
  for (const [type, value] of [
    ["Decimal(9, 2)", 1.25],
    ["Decimal(9, 2)", 0],
    ["Nullable(Decimal(9, 2))", 1.25],
    ["Array(Decimal(9, 2))", ["1.25", 2.5]],
    ["Array(Decimal(9, 2))", "1.25"],
    ["Decimal(9, 2)", null],
    ["Decimal(9, 2)", "NaN"],
    ["Decimal(9, 2)", "1e-2"],
    ["Decimal(9, 2)", "1.001"],
    ["Decimal(9, 2)", "12345678.00"],
    ["Decimal(0, 0)", "0"],
    ["Decimal(77, 2)", "0"],
    ["Decimal32(10)", "0"],
    ["Tuple(Decimal(9, 2), UInt32)", ["1.25", 7]],
    ["Map(String, Decimal(9, 2))", { a: "1.25" }],
    ["Array(".repeat(18) + "Decimal(9, 2)" + ")".repeat(18), []],
    ["Dynamic", 0.12345678901234568],
    ["Array(Dynamic)", [0.12345678901234568]],
    ["Tuple(UInt32, JSON)", [7, { d: 0.12345678901234568 }]],
    ["Object('json')", { d: 0.12345678901234568 }],
    [undefined, "0.1234567890123456789"],
  ]) {
    body = reply(type, value);
    await assert.rejects(queryClickHouse(input), /ClickHouse/);
  }
  body = JSON.stringify({
    meta: [{ name: "d", type: "Tuple(Decimal(9, 2), UInt32)" }],
    data: [],
  });
  await assert.rejects(queryClickHouse(input), /不支持此Decimal类型包装/);
  body = JSON.stringify({
    meta: [{ name: "d", type: "Decimal(9, 2)" }],
    data: [{}],
  });
  await assert.rejects(queryClickHouse(input), /Decimal列缺失/);
  body = JSON.stringify({
    meta: [
      { name: "d", type: "Decimal(9, 2)" },
      { name: "d", type: "String" },
    ],
    data: [],
  });
  await assert.rejects(queryClickHouse(input), /列名重复/);
  body = JSON.stringify({
    meta: [
      { name: "d", type: "Decimal(38, 19)" },
      { name: "n", type: "UInt32" },
      { name: "t", type: "Tuple(UInt32, Float64)" },
    ],
    data: [{ d: "0.1234567890123456789", n: 7, t: [9, 0.25] }],
    statistics: { elapsed: 0.123 },
  });
  assert.deepEqual((await queryClickHouse(input)).rows, [
    { d: "0.1234567890123456789", n: 7, t: [9, 0.25] },
  ]);
  status = 400;
  body = "UNKNOWN_SETTING output_format_json_quote_decimals";
  const before = requests;
  await assert.rejects(queryClickHouse(input), /UNKNOWN_SETTING/);
  assert.equal(requests, before + 1, "no precision-losing fallback request");
});
