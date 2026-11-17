import { MCPDatabaseGrants } from "../src/mcp-database-grants.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  querySQLite,
  mutateSQLite,
  querySQLiteBounded,
  mutateSQLiteBounded,
} from "../src/database.mjs";
import { runSQLiteProcess } from "../src/database-process.mjs";
import { DatabaseSessions } from "../src/database-sessions.mjs";

const sanitized = (error) => {
  assert.match(error.message, /SQLite数据库路径Unicode无效/);
  assert.equal(error.message.includes("private"), false);
  return true;
};
test("SQLite malformed filenames reject before fork or session grant", async () => {
  const original = childProcess.fork;
  let forks = 0;
  childProcess.fork = () => {
    forks++;
    throw Error("unexpected fork");
  };
  syncBuiltinESMExports();
  try {
    for (const char of ["\ud800", "\udfff"]) {
      const filename = "/private/db" + char;
      assert.throws(() => querySQLite(filename, "SELECT 1"), sanitized);
      assert.throws(
        () => mutateSQLite(filename, "UPDATE entries SET value=1"),
        sanitized,
      );
      await assert.rejects(querySQLiteBounded(filename, "SELECT 1"), sanitized);
      await assert.rejects(
        mutateSQLiteBounded(filename, "UPDATE entries SET value=1"),
        sanitized,
      );
      for (const mode of ["read", "write"])
        assert.throws(
          () => runSQLiteProcess({ filename, sql: "SELECT 1", mode }),
          sanitized,
        );
      const sessions = new DatabaseSessions();
      assert.throws(
        () =>
          sessions.register("p", { type: "sqlite", name: "test", filename }),
        sanitized,
      );
      assert.deepEqual(sessions.list("p"), []);
      const grants = new MCPDatabaseGrants(() => ({
        enabled: true,
        write: true,
        execute: true,
        projects: ["p"],
      }));
      assert.throws(
        () =>
          grants.register(
            { id: "p" },
            { type: "sqlite", name: "test", filename },
          ),
        sanitized,
      );
      assert.deepEqual(grants.list("p"), []);
    }
    assert.equal(forks, 0);
  } finally {
    childProcess.fork = original;
    syncBuiltinESMExports();
  }
});

test("real SQLite replacement-character target stays unchanged; legal Unicode works across bounded/session paths", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sqlite-filename-"));
  try {
    const filename = path.join(root, "中文🙂�.db");
    const bad = path.join(root, "中文🙂\ud800.db");
    const db = new DatabaseSync(filename);
    db.exec(
      "CREATE TABLE entries(value); INSERT INTO entries VALUES('before')",
    );
    db.close();
    for (const invoke of [
      () => querySQLite(bad, "SELECT value FROM entries"),
      () => mutateSQLite(bad, "UPDATE entries SET value='bad'"),
      () => querySQLiteBounded(bad, "SELECT value FROM entries"),
      () => mutateSQLiteBounded(bad, "UPDATE entries SET value='bad'"),
    ])
      await assert.rejects(async () => invoke(), sanitized);
    assert.deepEqual(querySQLite(filename, "SELECT value FROM entries").rows, [
      { value: "before" },
    ]);
    assert.equal(
      (await mutateSQLiteBounded(filename, "UPDATE entries SET value='after'"))
        .committed,
      true,
    );
    assert.deepEqual(
      (await querySQLiteBounded(filename, "SELECT value FROM entries")).rows,
      [{ value: "after" }],
    );
    const sessions = new DatabaseSessions();
    const grant = sessions.register("p", {
      type: "sqlite",
      name: "valid",
      filename,
    });
    assert.deepEqual(
      (
        await sessions.query("p", {
          connectionId: grant.id,
          sql: "SELECT value FROM entries",
          parameters: [],
        })
      ).rows,
      [{ value: "after" }],
    );
    // Bypass the parent guard to verify defense in the actual execution worker.
    for (const mode of ["read", "write"]) {
      const worker = new Worker(
        new URL("../src/database-execution-worker.mjs", import.meta.url),
        {
          workerData: {
            mode,
            filename: bad,
            sql:
              mode === "read"
                ? "SELECT value FROM entries"
                : "UPDATE entries SET value='bad'",
            parameters: [],
          },
        },
      );
      const reply = await new Promise((resolve, reject) => {
        worker.on("message", (m) => {
          if (m.error || m.result) resolve(m);
        });
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code) reject(Error("worker failed"));
        });
      });
      await worker.terminate();
      assert.equal(reply.result, undefined);
      sanitized(Error(reply.error));
    }
    assert.deepEqual(querySQLite(filename, "SELECT value FROM entries").rows, [
      { value: "after" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
