import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import childProcess from "node:child_process";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import {
  querySQLite,
  mutateSQLite,
  querySQLiteBounded,
  mutateSQLiteBounded,
} from "../src/database.mjs";
import { runSQLiteProcess } from "../src/database-process.mjs";
import { queryRemoteDatabase } from "../src/remote-database.mjs";
import {
  mutatePostgres,
  validatePostgresWrite,
} from "../src/postgres-write.mjs";
import {
  mutateMySQL,
  parseMySQLWrite,
  mysqlWriteUsage,
} from "../src/mysql-write.mjs";
import { normalizeDatabaseOperations } from "../src/script-database-tasks.mjs";
import { validateDatabaseOperationBinding } from "../src/plan-database-operation.mjs";
const read = (char) => `SELECT '${char}' AS value`;
const write = (char) => `INSERT INTO entries(value) VALUES ('${char}')`;
const config = {
  host: "127.0.0.1",
  port: 12345,
  user: "fixture",
  database: "fixture",
  allowWrite: true,
  parameters: [],
};

test("malformed SQL is rejected before fork, Worker, socket or MySQL slot admission", async () => {
  const originals = {
    fork: childProcess.fork,
    Worker: workerThreads.Worker,
    connect: net.Socket.prototype.connect,
  };
  const used = { fork: 0, worker: 0, connect: 0 };
  childProcess.fork = () => {
    used.fork++;
    throw Error("unexpected fork");
  };
  workerThreads.Worker = class {
    constructor() {
      used.worker++;
      throw Error("unexpected Worker");
    }
  };
  net.Socket.prototype.connect = function () {
    used.connect++;
    throw Error("unexpected connect");
  };
  syncBuiltinESMExports();
  try {
    for (const char of ["\ud800", "\udfff"]) {
      for (const type of ["postgres", "mysql"])
        await assert.rejects(
          queryRemoteDatabase({ ...config, type, sql: read(char) }),
        );
      await assert.rejects(
        mutatePostgres({ ...config, type: "postgres", sql: write(char) }),
      );
      const pending = mutateMySQL({
        ...config,
        type: "mysql",
        sql: write(char),
      });
      assert.equal(mysqlWriteUsage().active, 0);
      await assert.rejects(pending);
      await assert.rejects(parseMySQLWrite(write(char), "fixture"));
      assert.throws(() => validatePostgresWrite(write(char)));
      await assert.rejects(querySQLiteBounded("/not-opened", read(char)));
      await assert.rejects(mutateSQLiteBounded("/not-opened", write(char)));
      for (const mode of ["read", "write"])
        assert.throws(() =>
          runSQLiteProcess({ filename: "/not-opened", sql: read(char), mode }),
        );
    }
    assert.deepEqual(used, { fork: 0, worker: 0, connect: 0 });
  } finally {
    childProcess.fork = originals.fork;
    workerThreads.Worker = originals.Worker;
    net.Socket.prototype.connect = originals.connect;
    syncBuiltinESMExports();
  }
});
test("SQLite invalid SQL cannot mutate actual data; legal Unicode remains exact in sync and bounded paths", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sql-unicode-"));
  const filename = path.join(root, "fixture.db");
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE entries(value TEXT)");
  db.close();
  const before = await readFile(filename);
  for (const char of ["\ud800", "\udfff"]) {
    assert.throws(() => querySQLite(filename, read(char)));
    assert.throws(() => mutateSQLite(filename, write(char)));
    await assert.rejects(querySQLiteBounded(filename, read(char)));
    await assert.rejects(mutateSQLiteBounded(filename, write(char)));
  }
  assert.deepEqual(await readFile(filename), before);
  for (const value of ["中文🙂�", "ascii"]) {
    assert.equal(querySQLite(filename, read(value)).rows[0].value, value);
    assert.equal(
      (await querySQLiteBounded(filename, read(value))).rows[0].value,
      value,
    );
    assert.equal(mutateSQLite(filename, write(value)).committed, true);
    assert.equal(
      (await mutateSQLiteBounded(filename, write(value))).committed,
      true,
    );
  }
  assert.deepEqual(
    querySQLite(filename, "SELECT value FROM entries").rows.map((x) => x.value),
    ["中文🙂�", "中文🙂�", "ascii", "ascii"],
  );
});
test("native tasks and plan binding reject malformed literal SQL without rewriting legal definitions", () => {
  const task = (query) => [
    { connectionId: "fixture", query, isConsoleOutput: 0, variables: [] },
  ];
  const plan = (sql) => ({
    connectionId: "fixture",
    name: "result",
    sql,
    parameters: [],
  });
  for (const char of ["\ud800", "\udfff"]) {
    assert.throws(() => normalizeDatabaseOperations(task(read(char))));
    assert.throws(() => validateDatabaseOperationBinding(plan(read(char))));
  }
  const sql = read("中文🙂�");
  assert.equal(normalizeDatabaseOperations(task(sql))[0].query, sql);
  validateDatabaseOperationBinding(plan(sql));
});

test("valid SQL Unicode reaches real PG/MySQL drivers without normalization", async () => {
  const { startPostgresWritePeer } = await import(
    "./fixtures/postgres-write-peer.mjs"
  );
  const { startMySQLWritePeer } = await import(
    "./fixtures/mysql-write-peer.mjs"
  );
  const value = "中文🙂�";
  for (const mode of ["read", "write"]) {
    const peer = await startPostgresWritePeer();
    try {
      const input = {
        ...config,
        type: "postgres",
        port: peer.port,
        sql: mode === "read" ? read(value) : write(value),
      };
      const result = await (mode === "read"
        ? queryRemoteDatabase(input)
        : mutatePostgres(input));
      assert(peer.preparedSQL.some((sql) => sql.includes(`'${value}'`)));
      if (mode === "write") assert.equal(result.committed, true);
    } finally {
      await peer.close();
    }
  }
  const peer = await startMySQLWritePeer();
  try {
    const sql = write(value);
    assert.equal((await parseMySQLWrite(sql, "fixture")).sql, sql);
    assert.equal(
      (await mutateMySQL({ ...peer.input, sql, parameters: [] })).committed,
      true,
    );
    assert(
      peer.records.some(
        (record) => record.stage === "dml-execute" && record.sql === sql,
      ),
    );
  } finally {
    await peer.close();
  }
});
