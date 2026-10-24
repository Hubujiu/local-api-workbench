import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMySQLWrite,
  mutateMySQL,
  mysqlWriteUsage,
} from "../src/mysql-write.mjs";
const input = {
  type: "mysql",
  allowWrite: true,
  host: "127.0.0.1",
  user: "fixture",
  database: "fixture",
  sql: "INSERT INTO entries(id,value) VALUES (?,?)",
  parameters: [1, "fixture"],
};
function fixture({
  engine = "InnoDB",
  count = 1,
  warning = 0,
  failCommit = false,
  failRollback = false,
  slow = false,
} = {}) {
  const calls = [];
  let created = 0,
    rejectWrite;
  const createConnection = async (options) => {
    const role = created++ === 0 ? "main" : "control";
    calls.push([role, "connect", options]);
    return {
      threadId: role === "main" ? 41 : 42,
      on() {},
      destroy() {
        calls.push([role, "destroy"]);
        rejectWrite?.(Error("closed"));
      },
      async query(q) {
        const sql = typeof q === "string" ? q : q.sql;
        calls.push([role, sql]);
        if (sql.startsWith("KILL QUERY")) rejectWrite?.(Error("interrupted"));
        if (sql === "COMMIT" && failCommit)
          throw Error("commit acknowledgement lost");
        if (sql === "ROLLBACK" && failRollback) throw Error("rollback lost");
        return [[], []];
      },
      async execute(q, params) {
        const sql = typeof q === "string" ? q : q.sql;
        calls.push([role, "execute", sql, params]);
        if (sql.startsWith("SELECT ENGINE"))
          return [[[engine, "BASE TABLE"]], []];
        if (slow)
          return await new Promise((_, reject) => {
            rejectWrite = reject;
          });
        return [{ affectedRows: count, warningStatus: warning }, undefined];
      },
    };
  };
  return { createConnection, calls };
}
test("MySQL AST validation rejects batches, non-DML, joined or external-schema targets and ambiguous modifiers", async () => {
  for (const sql of [
    "SELECT 1",
    "DROP TABLE entries",
    "INSERT INTO entries VALUES(1); DELETE FROM entries",
    "UPDATE a JOIN b ON a.id=b.id SET a.x=1",
    "INSERT INTO entries SELECT * FROM other",
    "INSERT IGNORE INTO entries VALUES(1)",
    "INSERT INTO entries VALUES(1) ON DUPLICATE KEY UPDATE id=1",
    "UPDATE otherdb.entries SET id=1",
    "UPDATE entries SET id=(SELECT 1)",
    "DELETE FROM entries /* hidden */",
  ])
    await assert.rejects(parseMySQLWrite(sql, "fixture"), undefined, sql);
  for (const sql of [
    "INSERT INTO entries(id) VALUES (?)",
    "UPDATE entries SET value=? WHERE id=?",
    "DELETE FROM entries WHERE id=?",
  ])
    assert.equal((await parseMySQLWrite(sql, "fixture")).table, "entries");
});
test("MySQL write opt-in and explicit target are checked before connection", async () => {
  for (const patch of [
    { allowWrite: false },
    { allowWrite: "true" },
    { type: "postgres" },
    { host: "" },
    { user: "" },
    { database: "" },
    { parameters: null },
  ]) {
    const f = fixture();
    await assert.rejects(mutateMySQL({ ...input, ...patch }, f));
    assert.deepEqual(f.calls, []);
  }
});
test("MySQL transaction pins table metadata, requires InnoDB, binds parameters and commits a verified row count", async () => {
  const f = fixture(),
    r = await mutateMySQL(input, f);
  assert.equal(r.committed, true);
  assert.equal(r.affectedRows, 1);
  const sql = f.calls.filter((x) => x[0] === "main").map((x) => x[1]);
  assert(
    sql.indexOf("START TRANSACTION") <
      sql.findIndex((x) => String(x).startsWith("SELECT 1 FROM")),
  );
  assert.match(
    sql.find((x) => String(x).startsWith("SELECT 1 FROM")),
    /LIMIT 0 FOR UPDATE$/,
  );
  assert(sql.includes("COMMIT"));
  assert(!sql.includes("ROLLBACK"));
  assert(
    f.calls.some(
      (x) => x[1] === "connect" && x[2].flags.includes("FOUND_ROWS"),
    ),
  );
  const bad = fixture({ engine: "MyISAM" });
  await assert.rejects(mutateMySQL(input, bad), /InnoDB/);
  assert(
    !bad.calls.some((x) => x[1] === "execute" && x[2].startsWith("INSERT")),
  );
  assert.equal(mysqlWriteUsage().active, 0);
});
test("MySQL excess rows and warnings roll back while commit acknowledgement loss is never reported as success", async () => {
  for (const patch of [{ count: 1001 }, { warning: 1 }]) {
    const f = fixture(patch);
    await assert.rejects(mutateMySQL(input, f), /回滚/);
    assert(f.calls.some((x) => x[1] === "ROLLBACK"));
    assert(!f.calls.some((x) => x[1] === "COMMIT"));
  }
  const lost = fixture({ failCommit: true });
  await assert.rejects(mutateMySQL(input, lost), /提交结果未确认/);
  assert(!lost.calls.some((x) => x[1] === "ROLLBACK"));
  const rollback = fixture({ count: 1001, failRollback: true });
  await assert.rejects(mutateMySQL(input, rollback), /回滚确认/);
});
test("MySQL write deadline kills only its own query and never races cancellation into COMMIT", async () => {
  const f = fixture({ slow: true });
  await assert.rejects(
    mutateMySQL(input, { ...f, queryTimeoutMs: 50 }),
    /超时/,
  );
  assert.deepEqual(
    f.calls.filter((x) => x[1]?.startsWith?.("KILL QUERY")).map((x) => x[1]),
    ["KILL QUERY 41"],
  );
  assert(!f.calls.some((x) => x[1] === "COMMIT"));
  assert.equal(mysqlWriteUsage().active, 0);
});

test("MySQL concurrent write leases reject a sixth operation and are released on failure", async () => {
  const pending = Array.from({ length: 5 }, () =>
    mutateMySQL(input, {
      ...fixture({ slow: true }),
      queryTimeoutMs: 50,
    }).catch((error) => error),
  );
  const sixth = fixture();
  await assert.rejects(mutateMySQL(input, sixth), /最多同时执行5/);
  assert.deepEqual(sixth.calls, []);
  assert((await Promise.all(pending)).every((value) => value instanceof Error));
  assert.equal(mysqlWriteUsage().active, 0);
});
