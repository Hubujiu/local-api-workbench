// Real SQLite: ordinary CI only, not part of the local pure-helper check.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mutateSQLite, querySQLite } from "../src/database.mjs";

test("SQLite throwing operation observer cannot change commit or rollback outcomes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sqlite-observer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "fixture.db");
  const fixture = new DatabaseSync(file);
  fixture.exec(
    "CREATE TABLE fixture(id INTEGER PRIMARY KEY); INSERT INTO fixture VALUES(42)",
  );
  fixture.close();
  const stages = [];
  const throwing = (stage) => {
    stages.push(stage);
    throw Error("DIAGNOSTIC_MUST_NOT_REPLACE_SQL");
  };
  const result = mutateSQLite(
    file,
    "INSERT INTO fixture(id) VALUES (?) RETURNING id",
    [43],
    throwing,
  );
  assert.equal(result.committed, true);
  assert.equal(result.affectedRows, 1);
  assert.deepEqual(result.rows, [{ id: 43 }]);
  assert.deepEqual(stages, [
    "validate",
    "probe-open",
    "probe-close",
    "write-open",
    "begin",
    "prepare",
    "step",
    "changes",
    "commit",
    "commit-complete",
    "close",
    "close-complete",
  ]);
  stages.length = 0;
  assert.throws(
    () =>
      mutateSQLite(
        file,
        "INSERT INTO fixture(id) VALUES (?) RETURNING id",
        [42],
        throwing,
      ),
    (error) => {
      assert.match(error.message, /UNIQUE constraint failed/);
      assert(!error.message.includes("DIAGNOSTIC_MUST_NOT_REPLACE_SQL"));
      return true;
    },
  );
  assert.deepEqual(stages, [
    "validate",
    "probe-open",
    "probe-close",
    "write-open",
    "begin",
    "prepare",
    "step",
    "rollback",
    "close",
    "close-complete",
  ]);
  assert.equal(
    querySQLite(file, "SELECT count(*) AS n FROM fixture").rows[0].n,
    2,
  );
  assert.throws(
    () => mutateSQLite(file, "DROP TABLE fixture", [], throwing),
    /写入仅支持/,
  );
});
