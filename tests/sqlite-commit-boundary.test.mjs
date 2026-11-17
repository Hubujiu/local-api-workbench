import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// These are new, disposable databases, never readbacks of a user operation.
// Only the worker fixture changes. The mutation, parent and supervisor retain
// their real SQL, result-admission rules and independent two-second deadlines.
for (const boundary of ["before-commit", "after-commit", "after-result"]) {
  test(
    `SQLite unknown outcome at ${boundary} requires independent fixture readback, never replay`,
    { timeout: 8000 },
    async (t) => {
      const root = await mkdtemp(
        path.join(tmpdir(), "sqlite-commit-boundary-"),
      );
      t.after(() => rm(root, { recursive: true, force: true }));
      for (const name of [
        "database.mjs",
        "database-values.mjs",
        "sqlite-filename.mjs",
        "database-process.mjs",
        "database-process-entry.mjs",
        "database-read-cancellation.mjs",
        "sqlite-process-diagnostics.mjs",
        "sqlite-operation-progress.mjs",
      ]) {
        await copyFile(
          new URL("../src/" + name, import.meta.url),
          path.join(root, name),
        );
      }
      const filename = path.join(root, "fixture.db");
      const db = new DatabaseSync(filename);
      try {
        db.exec(
          "CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0)",
        );
      } finally {
        db.close();
      }
      await writeFile(
        path.join(root, "database-execution-worker.mjs"),
        `import { parentPort, workerData } from 'node:worker_threads';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { mutateSQLite } from './database.mjs';
const boundary = ${JSON.stringify(boundary)};
const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
parentPort.postMessage({ kind: 'sqlite-worker-ready' });
const started = performance.now();
const observe = stage => {
  // Hide the post-commit observation deliberately: both first cases leave the
  // same last observed stage, even though their durable outcomes differ.
  if (boundary === 'after-commit' && stage === 'commit-complete') block();
  parentPort.postMessage({ kind: 'sqlite-operation-stage', stage,
    elapsedMs: Math.round(performance.now() - started) });
  if (boundary === 'before-commit' && stage === 'commit') block();
};
appendFileSync(new URL('./executions.txt', import.meta.url), 'once\\n');
const result = mutateSQLite(workerData.filename, workerData.sql, [], observe);
parentPort.postMessage({ result });
// The supervisor has a worker result, but cannot admit success before exit.
if (boundary === 'after-result') block();
`,
      );
      const { runSQLiteProcess } = await import(
        pathToFileURL(path.join(root, "database-process.mjs")).href
      );
      let failure;
      await assert.rejects(
        runSQLiteProcess({
          filename,
          mode: "write",
          sql: "UPDATE counter SET value=value+1",
        }),
        (error) => {
          failure = error;
          assert.equal(error.code, "SQLITE_WRITE_OUTCOME_UNKNOWN");
          assert.equal(error.diagnostics.timeout, true);
          assert.equal(error.diagnostics.signal, "SIGKILL");
          assert.equal(error.diagnostics.receivedResult, false);
          assert.equal(error.diagnostics.resultReceivedMs, null);
          assert.equal(error.diagnostics.workerExitCode, null);
          assert.equal(
            error.diagnostics.operationStage,
            boundary === "after-result" ? "close-complete" : "commit",
          );
          assert.equal(
            error.diagnostics.phase,
            boundary === "after-result" ? "worker-result" : "worker-ready",
          );
          return true;
        },
      );
      // Rejection waits for actual process close. A normal SQLite open may
      // recover the disposable pre-commit journal. No SQL mutation is replayed.
      const recovery = new DatabaseSync(filename);
      let observedValue;
      try {
        observedValue = recovery
          .prepare("SELECT value FROM counter")
          .get().value;
      } finally {
        recovery.close();
      }
      assert.equal(observedValue, boundary === "before-commit" ? 0 : 1);
      assert.equal(
        await readFile(path.join(root, "executions.txt"), "utf8"),
        "once\n",
      );
      t.diagnostic(
        JSON.stringify({
          boundary,
          code: failure.code,
          operationStage: failure.diagnostics.operationStage,
          phase: failure.diagnostics.phase,
          fixtureReadback: observedValue,
          executionCount: 1,
        }),
      );
    },
  );
}
