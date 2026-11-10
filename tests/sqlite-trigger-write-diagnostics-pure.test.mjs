// Fake errors only. Do not open SQLite, start workers or spawn subprocesses.
import test from "node:test";
import assert from "node:assert/strict";
import {
  sqliteTestPhases,
  withSQLitePhase,
} from "./helpers/sqlite-phase-diagnostics.mjs";
const marker = "SQLITE_PHASE_METADATA ";
const phase = sqliteTestPhases.triggerWriteRollback;
const secret = "PRIVATE_SQL_PATH_PARAMS_SENTINEL";
function unknown() {
  return Object.assign(
    Error("数据库写入结果未确认，请先查询数据，不要直接重试"),
    {
      code: "SQLITE_WRITE_OUTCOME_UNKNOWN",
      diagnostics: {
        phase: "worker-exit",
        elapsedMs: 1000,
        timeout: false,
        exitCode: 1,
        signal: null,
        receivedResult: false,
        spawnErrorCode: null,
        processErrorCode: null,
        sendErrorCode: null,
        workerErrorCode: "ERR_WORKER_OUT_OF_MEMORY",
        workerExitCode: 1,
        supervisorReadyMs: 20,
        workerReadyMs: 35,
        resultReceivedMs: null,
        operationStage: "step",
        operationElapsedMs: 1000,
        sql: secret,
        filename: secret,
        parameters: [secret],
      },
    },
  );
}
function metadata(line) {
  assert(line.startsWith(marker));
  assert(Buffer.byteLength("\n" + line) <= 2048);
  assert(!line.includes(secret));
  return JSON.parse(line.slice(marker.length));
}
test("trigger-write unknown outcome with diagnostic 1000 still fails the original /1000/ assertion", async () => {
  const original = unknown(),
    before = Object.getOwnPropertyDescriptors(original),
    reports = [];
  let calls = 0;
  await assert.rejects(
    assert.rejects(
      withSQLitePhase(
        phase,
        async () => {
          calls++;
          throw original;
        },
        (line) => reports.push(line),
      ),
      /1000/,
    ),
    { code: "ERR_ASSERTION" },
  );
  assert.deepEqual(Object.getOwnPropertyDescriptors(original), before);
  assert.equal(calls, 1);
  assert.equal(reports.length, 1);
  const detail = metadata(reports[0]);
  assert.equal(detail.phase, phase);
  assert.equal(detail.code, original.code);
  assert.equal(detail.diagnostics.phase, "worker-exit");
  assert.equal(detail.diagnostics.timeout, false);
  assert.equal(detail.diagnostics.elapsedMs, 1000);
  assert.equal(detail.diagnostics.operationStage, "step");
  assert.equal(detail.diagnostics.operationElapsedMs, 1000);
  assert.equal(detail.diagnostics.exitCode, 1);
  assert.equal(detail.diagnostics.workerErrorCode, "ERR_WORKER_OUT_OF_MEMORY");
  assert.equal(detail.diagnostics.workerExitCode, 1);
  assert.equal(detail.diagnostics.receivedResult, false);
});
test("expected trigger limit rejection passes unchanged and later operations run once in order", async () => {
  const original = Object.assign(Error("写入及触发器修改超过1000行，已回滚"), {
    code: "unchanged",
  });
  const before = Object.getOwnPropertyDescriptors(original),
    order = [],
    reports = [];
  await assert.rejects(
    withSQLitePhase(
      phase,
      async () => {
        order.push("trigger-write");
        throw original;
      },
      (line) => reports.push(line),
    ),
    /1000/,
  );
  order.push("rollback-check", "oversized-returning");
  assert.deepEqual(order, [
    "trigger-write",
    "rollback-check",
    "oversized-returning",
  ]);
  assert.deepEqual(Object.getOwnPropertyDescriptors(original), before);
  assert.deepEqual(metadata(reports[0]), { phase });
});
test("unexpected mutation success still fails without reporting or retrying the operation", async () => {
  let calls = 0,
    reports = 0;
  await assert.rejects(
    assert.rejects(
      withSQLitePhase(
        phase,
        async () => {
          calls++;
          return { committed: true };
        },
        () => reports++,
      ),
      /1000/,
    ),
    { code: "ERR_ASSERTION" },
  );
  assert.equal(calls, 1);
  assert.equal(reports, 0);
});
test("a throwing reporter retains the original unknown error and all original properties", async () => {
  const original = unknown(),
    before = Object.getOwnPropertyDescriptors(original);
  let reports = 0,
    calls = 0;
  await assert.rejects(
    withSQLitePhase(
      phase,
      async () => {
        calls++;
        throw original;
      },
      () => {
        reports++;
        throw Error("reporter failure");
      },
    ),
    (error) => error === original,
  );
  assert.equal(calls, 1);
  assert.equal(reports, 1);
  assert.deepEqual(Object.getOwnPropertyDescriptors(original), before);
});
test("report-only diagnostics do not invoke getters and work with a frozen original error", async () => {
  const original = unknown(),
    reports = [];
  let reads = 0;
  Object.defineProperty(original.diagnostics, "elapsedMs", {
    get() {
      reads++;
      throw Error(secret);
    },
  });
  Object.freeze(original);
  await assert.rejects(
    withSQLitePhase(
      phase,
      () => Promise.reject(original),
      (line) => reports.push(line),
    ),
    (error) => error === original,
  );
  assert.equal(reads, 0);
  assert.equal(metadata(reports[0]).diagnostics.elapsedMs, null);
  assert(!original.message.includes(marker));
});
