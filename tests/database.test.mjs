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

test("explicit bounded SQLite mutation commits one statement and rolls back excessive changes", async (t) => {
  const { mutateSQLiteBounded } = await import("../src/database.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "sqlite-write-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "write.db"),
    db = new DatabaseSync(file);
  db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT)");
  db.close();
  const r = await mutateSQLiteBounded(
    file,
    "INSERT INTO items(name) VALUES (?)",
    ["a;b"],
  );
  assert.equal(r.affectedRows, 1);
  assert.equal(querySQLite(file, "SELECT name FROM items").rows[0].name, "a;b");
  await assert.rejects(
    mutateSQLiteBounded(file, "UPDATE items SET name='x'; DELETE FROM items"),
    /单条/,
  );
  await assert.rejects(
    mutateSQLiteBounded(file, "DROP TABLE items"),
    /INSERT|支持/,
  );
  const many = new DatabaseSync(file);
  many.exec(
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1001) INSERT INTO items(name) SELECT x FROM n",
  );
  many.close();
  await assert.rejects(
    mutateSQLiteBounded(file, "UPDATE items SET name='too many'"),
    /1000/,
  );
  assert.equal(
    querySQLite(file, "SELECT count(*) AS n FROM items WHERE name='too many'")
      .rows[0].n,
    0,
  );
  assert.equal(
    querySQLite(file, "SELECT count(*) AS n FROM items").rows[0].n,
    1002,
  );
});

test("SQLite writes preserve quoted delimiters, return values, and reject replacement/multiple statements", async (t) => {
  const { mutateSQLiteBounded } = await import("../src/database.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "sqlite-write-parser-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "write.db"),
    db = new DatabaseSync(file);
  db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT UNIQUE)");
  db.close();
  const result = await mutateSQLiteBounded(
    file,
    "INSERT INTO items(name) VALUES ('it''s; -- /* literal') RETURNING id, name; /* trailing ; */ -- ok",
  );
  assert.equal(result.committed, true);
  assert.equal(result.affectedRows, 1);
  assert.equal(result.rows[0].name, "it's; -- /* literal");
  for (const sql of [
    "INSERT OR /* gap */ REPLACE INTO items VALUES(1,'changed')",
    "UPDATE OR REPLACE items SET name='changed'",
    "INSERT INTO items VALUES(2,'ok'); /* gap */ DELETE FROM items",
    "INSERT INTO items VALUES(2,'unterminated)",
  ])
    await assert.rejects(mutateSQLiteBounded(file, sql));
  assert.equal(
    querySQLite(file, "SELECT name FROM items").rows[0].name,
    "it's; -- /* literal",
  );
  const update = await mutateSQLiteBounded(
    file,
    "UPDATE items SET name=replace(name, ?, ?) RETURNING name",
    ["literal", "text"],
  );
  assert.equal(update.rows[0].name, "it's; -- /* text");
  const deleted = await mutateSQLiteBounded(
    file,
    "DELETE FROM items WHERE id=? RETURNING id",
    [1],
  );
  assert.equal(deleted.rows[0].id, 1);
  assert.equal(
    querySQLite(file, "SELECT count(*) AS n FROM items").rows[0].n,
    0,
  );
});

test("SQLite write transaction rolls back trigger effects and oversized RETURNING output", async (t) => {
  const { mutateSQLiteBounded } = await import("../src/database.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "sqlite-write-rollback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "write.db"),
    db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE audit(id INTEGER); WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO audit SELECT x FROM n; CREATE TRIGGER track AFTER INSERT ON items BEGIN UPDATE audit SET id=id+1; END;",
  );
  db.close();
  await assert.rejects(
    mutateSQLiteBounded(file, "INSERT INTO items(name) VALUES ('rollback')"),
    /1000/,
  );
  assert.equal(
    querySQLite(file, "SELECT count(*) AS n FROM items").rows[0].n,
    0,
  );
  assert.equal(
    querySQLite(file, "SELECT min(id) AS n FROM audit").rows[0].n,
    1,
  );
  const setup = new DatabaseSync(file);
  setup.exec("DROP TRIGGER track");
  setup.close();
  await assert.rejects(
    mutateSQLiteBounded(
      file,
      "INSERT INTO items(name) VALUES ('large') RETURNING hex(zeroblob(600000)) AS value",
    ),
    /1MiB/,
  );
  assert.equal(
    querySQLite(file, "SELECT count(*) AS n FROM items").rows[0].n,
    0,
  );
});

test("database HTTP writes require local authentication, valid origin and explicit SQLite opt-in", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "sqlite-write-http-"));
  const app = await createApp({ root, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const project = await app.store.create("SQLite fixture");
  const filename = path.join(root, "fixture.db"),
    db = new DatabaseSync(filename);
  db.exec("CREATE TABLE entries(value TEXT)");
  db.close();
  const url = app.url + "/api/projects/" + project.id + "/database";
  const input = {
    filename,
    sql: "INSERT INTO entries VALUES (?)",
    parameters: ["fixture"],
    allowWrite: true,
  };
  const headers = {
    "content-type": "application/json",
    "x-local-token": app.token,
  };
  const post = (body, h = headers) =>
    fetch(url, { method: "POST", headers: h, body: JSON.stringify(body) });
  assert.equal(
    (await post(input, { "content-type": "application/json" })).status,
    403,
  );
  assert.equal(
    (await post(input, { ...headers, Origin: "https://untrusted.example" }))
      .status,
    403,
  );
  assert.equal((await post({ ...input, allowWrite: false })).ok, false);
  assert.equal((await post({ ...input, allowWrite: "true" })).ok, false);
  assert.equal((await post({ ...input, type: "mysql" })).ok, false);
  assert.equal(
    querySQLite(filename, "SELECT count(*) AS n FROM entries").rows[0].n,
    0,
  );
  const response = await post(input);
  assert.equal(response.ok, true, await response.clone().text());
  assert.equal((await response.json()).committed, true);
  assert.equal(
    querySQLite(filename, "SELECT count(*) AS n FROM entries").rows[0].n,
    1,
  );
});
