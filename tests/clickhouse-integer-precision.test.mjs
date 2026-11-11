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
const unsafe = [
  9007199254740992,
  -9007199254740992,
  JSON.parse("9007199254740993"),
  JSON.parse("18446744073709551615"),
  1e100,
];

test("ClickHouse rejects unsafe integer parameters before HTTP or HTTPS in direct and remote paths", async (t) => {
  let requests = 0;
  const trap = () => {
    requests++;
    throw Error("unexpected transport");
  };
  t.mock.method(http, "request", trap);
  t.mock.method(https, "request", trap);
  for (const ssl of [false, true])
    for (const value of unsafe)
      for (const parameters of [
        [value],
        [1, value, "exact"],
        { id: value },
        { first: "exact", id: value },
      ]) {
        const input = { ...base, ssl, parameters };
        const message = (error) => {
          assert.equal(error.message, "ClickHouse大整数参数请使用精确字符串");
          return true;
        };
        assert.throws(() => clickhouseRequest(input), message);
        await assert.rejects(queryClickHouse(input), message);
        await assert.rejects(queryRemoteDatabase(input), message);
      }
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => clickhouseRequest({ ...base, parameters: [value] }),
      /有限数字/,
    );
    await assert.rejects(
      queryClickHouse({ ...base, parameters: { id: value } }),
      /有限数字/,
    );
    await assert.rejects(
      queryRemoteDatabase({ ...base, parameters: [value] }),
      /有限数字/,
    );
  }
  assert.equal(requests, 0);
});

test("ClickHouse real HTTP parameters preserve safe integer boundaries, finite fractions and exact numeric strings", async (t) => {
  const seen = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    seen.push({
      method: request.method,
      values: Object.fromEntries(
        [...url.searchParams].filter(([key]) => key.startsWith("param_")),
      ),
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
  const values = [
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    0,
    -0,
    1.25,
    -0.25,
    Number.MIN_VALUE,
    "9007199254740993",
    "18446744073709551615",
    "0.100000000000000005",
    true,
    null,
  ];
  const expected = values.map((value) =>
    value === null ? "\\N" : String(value),
  );
  for (const query of [queryClickHouse, queryRemoteDatabase])
    for (const named of [false, true]) {
      const parameters = named
        ? Object.fromEntries(values.map((value, i) => [`v${i}`, value]))
        : values;
      const result = await query({
        ...base,
        port: server.address().port,
        parameters,
      });
      assert.deepEqual(result.rows, [{ value: "fixture" }]);
      assert.deepEqual(seen.at(-1), {
        method: "GET",
        values: Object.fromEntries(
          expected.map((value, i) => [`param_${named ? "v" : "p"}${i}`, value]),
        ),
      });
    }
});

test("ClickHouse integer policy does not claim to recover JSON fraction spelling or UI nonfinite-to-null conversion", () => {
  assert.equal(JSON.parse("9007199254740993"), 9007199254740992);
  const rounded = JSON.parse("0.100000000000000005");
  assert.equal(rounded, 0.1);
  assert.equal(
    clickhouseRequest({ ...base, parameters: [rounded] }).url.searchParams.get(
      "param_p0",
    ),
    "0.1",
  );
  const underflow = JSON.parse("1e-400");
  assert.equal(underflow, 0);
  assert.equal(
    clickhouseRequest({
      ...base,
      parameters: [underflow],
    }).url.searchParams.get("param_p0"),
    "0",
  );
  const uiPayload = JSON.parse(
    JSON.stringify({ parameters: JSON.parse("[1e400]") }),
  );
  assert.deepEqual(uiPayload.parameters, [null]);
  // An intentional null must remain supported. The backend cannot infer that
  // a client might previously have converted Infinity into this null.
  assert.equal(
    clickhouseRequest({ ...base, ...uiPayload }).url.searchParams.get(
      "param_p0",
    ),
    "\\N",
  );
});
