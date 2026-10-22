import test from "node:test";
import assert from "node:assert/strict";
import {
  mutatePostgres,
  validatePostgresWrite,
} from "../src/postgres-write.mjs";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
const input = {
  type: "postgres",
  allowWrite: true,
  host: "127.0.0.1",
  user: "fixture",
  database: "fixture",
  sql: "INSERT INTO entries(value) VALUES ($1)",
  parameters: ["private fixture"],
};
function fixture({ count = "1", failQuery, failCommit, failRollback } = {}) {
  const calls = [];
  let options;
  class Client {
    constructor(value) {
      options = value;
      calls.push("construct");
    }
    async connect() {
      calls.push("connect");
    }
    async query(query) {
      calls.push(query);
      if (typeof query === "object" || query.startsWith("SELECT")) {
        if (failQuery) throw Error("fixture query failure");
        return {
          rows: [{ affected_rows: count }],
          fields: [{ name: "affected_rows" }],
        };
      }
      if (query === "COMMIT" && failCommit)
        throw Error("fixture commit failure");
      if (query === "ROLLBACK" && failRollback)
        throw Error("fixture rollback failure");
      return {};
    }
    async end() {
      calls.push("end");
    }
  }
  return { Client, calls, options: () => options };
}
test("PostgreSQL writes require explicit target and grant before connection", async () => {
  for (const patch of [
    { allowWrite: false },
    { allowWrite: "true" },
    { allowWrite: undefined },
    { type: "mysql" },
    { host: "" },
    { database: "" },
    { user: "" },
    { parameters: {} },
    { parameters: null },
  ]) {
    const f = fixture();
    await assert.rejects(mutatePostgres({ ...input, ...patch }, f));
    assert.deepEqual(f.calls, []);
  }
});
test("PostgreSQL DML wrapper rejects statement and CTE escape syntax", () => {
  for (const sql of [
    "SELECT 1",
    "WITH x AS (SELECT 1) DELETE FROM entries",
    "DROP TABLE entries",
    "INSERT INTO entries VALUES (1); DELETE FROM entries",
    "INSERT INTO entries VALUES (1)) SELECT '0' AS affected_rows --",
    "INSERT INTO entries VALUES (1) RETURNING *",
    "INSERT INTO entries VALUES ($$text$$)",
    "INSERT INTO entries VALUES ('a\\'b')",
    "INSERT INTO entries VALUES (1) /* hidden */",
    "INSERT INTO entries VALUES ('unclosed)",
    "INSERT INTO entries VALUES ((1)",
  ])
    assert.throws(() => validatePostgresWrite(sql), undefined, sql);
  assert.equal(
    validatePostgresWrite("INSERT INTO entries VALUES ($1); "),
    "INSERT INTO entries VALUES ($1)",
  );
  assert.equal(
    validatePostgresWrite(
      "UPDATE entries SET value = 'literal ) -- /* RETURNING'",
    ),
    "UPDATE entries SET value = 'literal ) -- /* RETURNING'",
  );
});
test("PostgreSQL explicit DML uses extended protocol, bounded count, strict TLS and commit acknowledgement", async () => {
  const f = fixture({ count: "1000" });
  const result = await mutatePostgres(
    { ...input, ssl: true, ca: "fixture CA" },
    f,
  );
  assert.equal(result.committed, true);
  assert.equal(result.affectedRows, 1000);
  assert.deepEqual(result.rows, []);
  assert.equal(JSON.stringify(result).includes("private fixture"), false);
  const query = f.calls.find((v) => typeof v === "object");
  assert.equal(query.queryMode, "extended");
  assert.deepEqual(query.values, input.parameters);
  assert.match(
    query.text,
    /RETURNING 1\) SELECT count\(\*\)::text AS affected_rows/,
  );
  assert.equal(f.options().ssl.rejectUnauthorized, true);
  assert.equal(f.options().statement_timeout, 2000);
  assert.deepEqual(
    f.calls.filter((v) => typeof v === "string"),
    ["construct", "connect", "BEGIN READ WRITE", "COMMIT", "end"],
  );
});
test("PostgreSQL count overflow, malformed count and query failures roll back without commit", async () => {
  for (const config of [
    { count: "1001" },
    { count: "NaN" },
    { count: "-1" },
    { count: "9007199254740993" },
    { failQuery: true },
  ]) {
    const f = fixture(config);
    await assert.rejects(mutatePostgres(input, f), /已回滚/);
    assert.ok(f.calls.includes("ROLLBACK"));
    assert.equal(f.calls.includes("COMMIT"), false);
    assert.equal(f.calls.at(-1), "end");
  }
});
test("PostgreSQL uncertain commit or rollback is never retried or called successful", async () => {
  const commit = fixture({ failCommit: true });
  await assert.rejects(mutatePostgres(input, commit), /提交结果未确认/);
  assert.equal(commit.calls.filter((c) => c === "COMMIT").length, 1);
  assert.equal(commit.calls.includes("ROLLBACK"), false);
  const rollback = fixture({ failQuery: true, failRollback: true });
  await assert.rejects(mutatePostgres(input, rollback), /未收到回滚确认/);
  assert.equal(rollback.calls.at(-1), "end");
});

test("PostgreSQL read-only path also forbids multi-command protocol and ignores write flags", async () => {
  const f = fixture();
  await queryRemoteDatabase({ ...input, sql: "SELECT 1" }, f);
  const query = f.calls.find((value) => typeof value === "object");
  assert.equal(
    query?.queryMode,
    "extended",
    "empty parameters must not select simple multi-statement protocol",
  );
  assert.ok(f.calls.includes("BEGIN READ ONLY"));
  assert.equal(f.calls.includes("COMMIT"), false);
});
