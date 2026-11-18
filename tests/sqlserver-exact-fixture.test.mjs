import test from "node:test";
import assert from "node:assert/strict";
import { verifySQLServerExactFixture } from "./helpers/sqlserver-exact-fixture.mjs";
const expected = {
  exact_amount: "9007199254740993.123456789012345678",
  exact_stamp: "2026-11-18T02:03:04.1234567",
  exact_offset: "2026-11-18T02:03:04.1234567+05:30",
  exact_clock: "02:03:04.1234567",
  exact_day: "0001-01-01",
};
const connection = { host: "PRIVATE_HOST", password: "PRIVATE_PASSWORD" };
const respond = async (input) => {
  const column = input.sql.match(
    /^SELECT (exact_[a-z]+) FROM dbo.workbench_sqlserver_gate WHERE id=@p0$/,
  )?.[1];
  assert.ok(Object.hasOwn(expected, column));
  return {
    columns: [column],
    rows: [{ [column]: input.parameters[0] === 1 ? expected[column] : null }],
    truncated: false,
    limit: 1000,
  };
};
test("fixed exact fixture probes all types and SQL NULLs through the same supplied provider", async () => {
  const stages = [],
    calls = [];
  await verifySQLServerExactFixture(connection, {
    onStage: (s) => stages.push(s),
    query: async (input) => {
      calls.push(input);
      return respond(input);
    },
  });
  assert.equal(calls.length, 10);
  assert.equal(stages.length, 30);
  assert.equal(stages[0], "decimal/value/provider-query");
  assert.equal(stages.at(-1), "date/null/exact-value");
  assert.ok(
    calls.every(
      (c) => c.type === "sqlserver" && c.password === connection.password,
    ),
  );
  assert.ok(!JSON.stringify(stages).includes("PRIVATE"));
});
test("diagnostic stages distinguish provider rejection, shape and exact value without revealing data", async () => {
  for (const [mode, last] of [
    ["query", "datetimeoffset/value/provider-query"],
    ["shape", "datetimeoffset/value/result-shape"],
    ["value", "datetimeoffset/value/exact-value"],
  ]) {
    const stages = [];
    await assert.rejects(
      verifySQLServerExactFixture(connection, {
        onStage: (s) => stages.push(s),
        query: async (input) => {
          const result = await respond(input);
          if (input.sql.includes("exact_offset") && input.parameters[0] === 1) {
            if (mode === "query") throw Error("PRIVATE_DRIVER_MESSAGE");
            if (mode === "shape") result.rows = [];
            if (mode === "value") result.rows[0].exact_offset = "PRIVATE_DATA";
          }
          return result;
        },
      }),
      (error) => !String(error).includes("PRIVATE"),
    );
    assert.equal(stages.at(-1), last);
    assert.ok(!JSON.stringify(stages).includes("PRIVATE"));
  }
});
