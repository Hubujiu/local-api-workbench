import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { querySQLite } from "../src/database.mjs";
test("database reads use parameters and refuse writes", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-db-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "test.db"),
    db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE users(id INTEGER, name TEXT); INSERT INTO users VALUES(1,'Alice')",
  );
  db.close();
  assert.equal(
    querySQLite(file, "SELECT * FROM users WHERE id=?", [1]).rows[0].name,
    "Alice",
  );
  assert.throws(() => querySQLite(file, "DELETE FROM users"), /只读/);
  assert.throws(() => querySQLite(file, "SELECT load_extension('bad')"));
});
test("bounded worker returns database result", async (t) => {
  const { querySQLiteBounded } = await import("../src/database.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-db-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "test.db"),
    db = new DatabaseSync(file);
  db.exec("CREATE TABLE sample(id INTEGER)");
  db.close();
  assert.equal(
    (await querySQLiteBounded(file, "SELECT 42 AS answer")).rows[0].answer,
    42,
  );
});
