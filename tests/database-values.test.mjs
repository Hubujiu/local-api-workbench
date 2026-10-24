import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { querySQLiteBounded, mutateSQLiteBounded } from "../src/database.mjs";
test("SQLite preserves signed64 IDs and blobs across explicit write, read and JSON roundtrip", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "db-values-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "values.db");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE sample(id INTEGER PRIMARY KEY,payload BLOB,label TEXT)",
  );
  db.close();
  const written = await mutateSQLiteBounded(
    file,
    "INSERT INTO sample VALUES(?,?,?) RETURNING id,payload,label",
    [
      { type: "int64", value: "9007199254740993" },
      { type: "blob", base64: "AAH/" },
      "精确值",
    ],
  );
  assert.equal(written.rows[0].id, "9007199254740993");
  assert.deepEqual(written.rows[0].payload, { type: "blob", base64: "AAH/" });
  const read = await querySQLiteBounded(
    file,
    "SELECT id,payload,label FROM sample WHERE id=?",
    [{ type: "int64", value: "9007199254740993" }],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(read.rows)), written.rows);
  assert.equal(
    (await querySQLiteBounded(file, "SELECT 42 AS small")).rows[0].small,
    42,
  );
});
test("database value boundaries refuse duplicate columns and invalid typed inputs rather than silently losing values", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "db-values-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "values.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE sample(id INTEGER)");
  db.close();
  await assert.rejects(
    querySQLiteBounded(file, "SELECT 1 AS same,2 AS same"),
    /重复列/,
  );
  for (const value of [
    { type: "int64", value: "9223372036854775808" },
    { type: "blob", base64: "***" },
    9007199254740992,
  ])
    await assert.rejects(
      querySQLiteBounded(file, "SELECT ? AS value", [value]),
    );
  await assert.rejects(
    querySQLiteBounded(file, "SELECT hex(zeroblob(600000)) AS huge"),
    /1MiB/,
  );
});

test("PostgreSQL value parsers stay scoped and preserve JSON integers and precise arrays", async () => {
  const { types } = await import("pg");
  const { postgresValueTypes } = await import("../src/postgres-values.mjs");
  const native = types.getTypeParser(1114);
  assert(native("2026-10-24 12:34:56.123456") instanceof Date);
  assert.equal(
    postgresValueTypes.getTypeParser(1114)("2026-10-24 12:34:56.123456"),
    "2026-10-24 12:34:56.123456",
  );
  assert.equal(types.getTypeParser(1114), native);
  assert.deepEqual(
    postgresValueTypes.getTypeParser(3802)('{"id":9007199254740993,"small":1}'),
    { id: "9007199254740993", small: 1 },
  );
  assert.deepEqual(
    postgresValueTypes.getTypeParser(1231)("{1.234567890123456789,NULL,2}"),
    ["1.234567890123456789", null, "2"],
  );
});
test("SQLite HTTP read/write and project database operations retain exact values through persisted plan results", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { Store } = await import("../src/runtime.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "database-values-http-")),
    app = await createApp({ root, port: 0 });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const p = await app.store.create("values"),
    file = path.join(root, "values.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY,payload BLOB)");
  db.close();
  const base = app.url + "/api/projects/" + p.id,
    headers = {
      "content-type": "application/json",
      "x-local-token": app.token,
    };
  const post = async (action, data) => {
    const r = await fetch(base + "/" + action, {
      method: "POST",
      headers,
      body: JSON.stringify(data),
    });
    const value = await r.json();
    assert.equal(r.status, 200, JSON.stringify(value));
    return value;
  };
  const parameters = [
    { type: "int64", value: "9007199254740993" },
    { type: "blob", base64: "AAH/" },
  ];
  await post("database", {
    type: "sqlite",
    filename: file,
    allowWrite: true,
    sql: "INSERT INTO sample VALUES(?,?)",
    parameters,
  });
  const selected = await post("database", {
    type: "sqlite",
    filename: file,
    sql: "SELECT * FROM sample",
  });
  assert.equal(selected.rows[0].id, "9007199254740993");
  assert.deepEqual(selected.rows[0].payload, parameters[1]);
  const http = await import("node:http");
  const echo = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ id: req.headers["x-id"], blob: req.headers["x-blob"] }),
    );
  });
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => echo.close(r)));
  const connection = await post("database-connections", {
    type: "sqlite",
    filename: file,
    name: "fixture",
  });
  const plan = await post("plans", {
    steps: [
      {
        request: {
          method: "GET",
          url: `http://127.0.0.1:${echo.address().port}/echo`,
          beforeScript:
            'apt.setRequestHeader("X-ID",apt.getVar("exact").id); apt.setRequestHeader("X-Blob",apt.getVar("exact").payload.base64);',
          afterScript:
            'pm.test("exact response",()=>{pm.expect(pm.response.json().id).to.equal(apt.getVar("exact").id);pm.expect(pm.response.json().blob).to.equal(apt.getVar("exact").payload.base64);});',
          before: [
            {
              type: "database",
              connectionId: connection.id,
              sql: "SELECT id,payload FROM sample",
              parameters: [],
              path: "$.rows[0]",
              name: "exact",
            },
          ],
        },
      },
    ],
  });
  const run = await post("run", { planId: plan.id });
  assert.equal(run.status, "passed");
  assert.deepEqual(JSON.parse(run.results[0].response.body), {
    id: "9007199254740993",
    blob: "AAH/",
  });
  assert.equal(run.variables.exact.id, "9007199254740993");
  assert.deepEqual(run.variables.exact.payload, parameters[1]);
  const saved = await new Store(root).get(p.id);
  assert.equal(saved.runs[0].variables.exact.id, "9007199254740993");
  assert.deepEqual(saved.runs[0].variables.exact.payload, parameters[1]);
});
