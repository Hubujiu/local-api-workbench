import test from "node:test";
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { querySQLiteBounded, mutateSQLiteBounded } from "../src/database.mjs";
const execute = promisify(execFile);
const heavy =
  "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n";

for (const mode of ["read", "write"]) {
  test(
    `SQLite ${mode} timeout stops native execution and leaves no child keeping its caller alive`,
    { timeout: 12000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "sqlite-hard-timeout-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const file = path.join(root, "values.db");
      const db = new DatabaseSync(file);
      db.exec(
        "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES(1,'before')",
      );
      if (mode === "write")
        db.exec(
          `CREATE TABLE audit(payload BLOB); CREATE TRIGGER wait_forever AFTER UPDATE ON items BEGIN INSERT INTO audit SELECT zeroblob(8192) FROM (WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) SELECT x FROM n); ${heavy}; END`,
        );
      db.close();
      const operation =
        mode === "read" ? "querySQLiteBounded" : "mutateSQLiteBounded";
      const sql =
        mode === "read"
          ? heavy
          : "UPDATE items SET value='unconfirmed' WHERE id=1";
      // --input-type and arbitrary parent execArgv must not leak to the file child.
      // The outer timeout is only a test fail-safe. Success must be a natural exit.
      const script = `import {${operation}} from ${JSON.stringify(new URL("../src/database.mjs", import.meta.url).href)};
      try { await ${operation}(${JSON.stringify(file)},${JSON.stringify(sql)}); process.exitCode=2; }
      catch(error) { console.log(JSON.stringify({code:error.code,message:error.message})); }`;
      const started = Date.now();
      const { stdout } = await execute(
        process.execPath,
        ["--input-type=module", "-e", script],
        { timeout: 6500, maxBuffer: 65536 },
      );
      assert(
        Date.now() - started >= 1900,
        "must actually reach the execution timeout, not fail at startup",
      );
      const result = JSON.parse(stdout);
      assert.equal(
        result.code,
        mode === "read"
          ? "SQLITE_QUERY_TIMEOUT"
          : "SQLITE_WRITE_OUTCOME_UNKNOWN",
      );
      if (mode === "write") {
        assert.match(result.message, /不要直接重试/);
        assert(
          (await stat(file + "-journal")).size > 0,
          "killed mutation must exercise real journal recovery",
        );
      }
      // Use SQLite's normal read-write open for journal recovery, never delete a
      // journal or replay a potentially committed mutation to obtain a result.
      const recovery = new DatabaseSync(file);
      assert.equal(
        recovery.prepare("SELECT value FROM items").get().value,
        "before",
      );
      recovery.exec("BEGIN IMMEDIATE; ROLLBACK");
      if (mode === "write") {
        assert.equal(
          recovery.prepare("SELECT count(*) AS n FROM audit").get().n,
          0,
        );
        recovery.exec("DROP TRIGGER wait_forever");
      }
      recovery.close();
      assert.equal(
        (await querySQLiteBounded(file, "SELECT value FROM items")).rows[0]
          .value,
        "before",
      );
      assert.equal(
        (
          await mutateSQLiteBounded(
            file,
            "UPDATE items SET value='after' WHERE id=1",
          )
        ).affectedRows,
        1,
      );
      assert.equal(
        (await querySQLiteBounded(file, "SELECT value FROM items")).rows[0]
          .value,
        "after",
      );
    },
  );
}

test("SQLite process errors settle and subsequent independent operations work", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sqlite-process-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "values.db"),
    db = new DatabaseSync(file);
  db.exec("CREATE TABLE sample(x)");
  db.close();
  await assert.rejects(
    querySQLiteBounded(file, "SELECT unknown FROM sample"),
    /unknown/,
  );
  await assert.rejects(querySQLiteBounded(file, "SELECT ?", [() => 1]));
  assert.equal(
    (await querySQLiteBounded(file, "SELECT 7 AS value")).rows[0].value,
    7,
  );
});

for (const disconnect of [false, true]) {
  test(
    `SQLite supervisor terminates native work when ${disconnect ? "parent channel is lost" : "parent deadline enforcement is absent"}`,
    { timeout: 8000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "sqlite-supervisor-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const file = path.join(root, "values.db");
      const db = new DatabaseSync(file);
      db.exec("CREATE TABLE sample(x)");
      db.close();
      const child = fork(
        new URL("../src/database-process-entry.mjs", import.meta.url),
        {
          execArgv: ["--max-old-space-size=16"],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          serialization: "advanced",
        },
      );
      let forced = false,
        disconnectTimer;
      const started = Date.now();
      const outcome = await new Promise((resolve, reject) => {
        const failSafe = setTimeout(() => {
          forced = true;
          child.kill("SIGKILL");
        }, 5000);
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          clearTimeout(failSafe);
          clearTimeout(disconnectTimer);
          resolve({ code, signal });
        });
        child.send(
          { filename: file, sql: heavy, parameters: [], mode: "read" },
          (error) => {
            if (error) reject(error);
          },
        );
        if (disconnect)
          disconnectTimer = setTimeout(() => {
            if (child.connected) child.disconnect();
          }, 500);
      });
      assert.equal(
        forced,
        false,
        "the supervisor must end native execution without test cleanup killing it",
      );
      assert.notEqual(
        outcome.code,
        0,
        "the native query must not report success",
      );
      assert(Date.now() - started < 4500);
      assert.equal(
        (await querySQLiteBounded(file, "SELECT 9 AS value")).rows[0].value,
        9,
      );
    },
  );
}
