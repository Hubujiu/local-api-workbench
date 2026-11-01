import test from "node:test";
import assert from "node:assert/strict";
import {
  createSQLiteOperationTracker,
  sqliteOperationDetails,
  sqliteOperationMessageLimit,
} from "../src/sqlite-operation-progress.mjs";
import { sqliteProcessFailureDetails } from "../src/sqlite-process-diagnostics.mjs";
import {
  withSQLitePhase,
  sqliteTestPhases,
} from "./helpers/sqlite-phase-diagnostics.mjs";

const message = (stage, elapsedMs = 0) => ({
  kind: "sqlite-operation-stage",
  stage,
  elapsedMs,
});
const successStages = [
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
];
const secret = "PRIVATE_SQL_PATH_PARAMS_CREDENTIAL_SENTINEL\ud800";

test("SQLite progress accepts the fixed success path with independent copies", () => {
  const track = createSQLiteOperationTracker();
  for (const [index, stage] of successStages.entries()) {
    const value = message(stage, index);
    const observation = track(value);
    assert.deepEqual(observation, value);
    assert.notEqual(observation, value);
  }
  assert.equal(track(message("close-complete", 15)), null);
});

test("SQLite progress accepts rollback only before commit acknowledgement", () => {
  for (const failed of ["begin", "prepare", "step", "changes", "commit"]) {
    const track = createSQLiteOperationTracker();
    assert(track(message(failed, 1)));
    assert(track(message("rollback", 2)));
    assert.equal(track(message("commit-complete", 3)), null);
    assert(track(message("close", 3)));
    assert(track(message("close-complete", 4)));
  }
  const track = createSQLiteOperationTracker();
  assert(track(message("commit-complete", 1)));
  assert.equal(track(message("rollback", 2)), null);
  assert(track(message("close", 2)));
});

test("SQLite progress permits missing observations but not duplicates or reversal", () => {
  const track = createSQLiteOperationTracker();
  assert(track(message("probe-open", 3)));
  assert(track(message("step", 3)));
  assert.equal(track(message("step", 4)), null);
  assert.equal(track(message("begin", 5)), null);
  assert.equal(track(message("changes", 2)), null);
  assert(track(message("commit", 5)));
  assert(track(message("close-complete", 5)));
});

test("SQLite progress caps all attempts and never resumes after overflow", () => {
  const track = createSQLiteOperationTracker();
  assert(track(message("begin", 1)));
  for (let i = 1; i < sqliteOperationMessageLimit; i++)
    assert.equal(track(message(secret, i)), null);
  for (let i = 0; i < 100; i++)
    assert.equal(track(message("commit-complete", 2)), null);
  assert(createSQLiteOperationTracker()(message("commit-complete", 2)));
});

test("SQLite progress requires exactly three own data properties", () => {
  for (const value of [
    null,
    undefined,
    false,
    2,
    secret,
    [],
    { ...message("step"), sql: secret },
    { ...message("step"), [Symbol(secret)]: secret },
    Object.create(message("step")),
    { stage: "step", elapsedMs: 0 },
    { ...message("step"), kind: secret },
  ])
    assert.equal(createSQLiteOperationTracker()(value), null);
  const inert = Object.assign(Object.create(null), message("step"));
  assert.deepEqual(createSQLiteOperationTracker()(inert), message("step"));
});

test("SQLite progress never invokes accessors, proxy traps or conversion hooks", () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw Error("must not execute");
  };
  const proxy = new Proxy(message("step"), {
    get: trap,
    ownKeys: trap,
    getOwnPropertyDescriptor: trap,
    getPrototypeOf: trap,
  });
  const revoked = Proxy.revocable(message("step"), {});
  revoked.revoke();
  for (const value of [proxy, revoked.proxy])
    assert.equal(createSQLiteOperationTracker()(value), null);
  for (const key of ["kind", "stage", "elapsedMs"]) {
    const value = message("step");
    Object.defineProperty(value, key, { get: trap });
    assert.equal(createSQLiteOperationTracker()(value), null);
  }
  const hostile = { toJSON: trap, [Symbol.toPrimitive]: trap };
  assert.equal(createSQLiteOperationTracker()(message(hostile)), null);
  assert.equal(createSQLiteOperationTracker()(message("step", hostile)), null);
  assert.equal(calls, 0);
});

test("SQLite progress integer time boundaries and malformed stages are bounded", () => {
  for (const invalid of [-1, 0.5, Infinity, NaN, 86400001, "1", 1n, null]) {
    assert.equal(
      createSQLiteOperationTracker()(message("step", invalid)),
      null,
    );
    assert.deepEqual(sqliteOperationDetails("step", invalid), {});
  }
  for (const valid of [0, 86400000])
    assert(createSQLiteOperationTracker()(message("step", valid)));
  for (const stage of [
    "start",
    "__proto__",
    "constructor",
    secret,
    "x".repeat(100000),
  ])
    assert.equal(createSQLiteOperationTracker()(message(stage)), null);
});

test("SQLite progress public reconstruction never changes unknown-write status", () => {
  const details = sqliteProcessFailureDetails({
    code: "SQLITE_WRITE_OUTCOME_UNKNOWN",
    diagnostics: {
      phase: "worker-ready",
      timeout: true,
      receivedResult: false,
      operationStage: "commit-complete",
      operationElapsedMs: 8,
      sql: secret,
      filename: secret,
      parameters: [secret],
    },
  });
  assert.equal(details.code, "SQLITE_WRITE_OUTCOME_UNKNOWN");
  assert.equal(details.diagnostics.phase, "worker-ready");
  assert.equal(details.diagnostics.receivedResult, false);
  assert.equal(details.diagnostics.operationStage, "commit-complete");
  assert.equal(details.diagnostics.operationElapsedMs, 8);
  assert(!JSON.stringify(details).includes("PRIVATE_"));
  assert(Buffer.byteLength(JSON.stringify(details)) < 1024);
  for (const [stage, elapsed] of [
    [secret, 1],
    ["step", secret],
  ]) {
    const d = sqliteProcessFailureDetails({
      code: "SQLITE_WRITE_OUTCOME_UNKNOWN",
      diagnostics: { operationStage: stage, operationElapsedMs: elapsed },
    });
    assert(!Object.hasOwn(d.diagnostics, "operationStage"));
    assert(!Object.hasOwn(d.diagnostics, "operationElapsedMs"));
  }
});

test("SQLite phase suffix retains bounded operation evidence and original error", async () => {
  const error = new Error("original error");
  error.code = "SQLITE_WRITE_OUTCOME_UNKNOWN";
  error.diagnostics = {
    operationStage: "commit-complete",
    operationElapsedMs: 4,
    sql: secret,
  };
  let calls = 0;
  await assert.rejects(
    withSQLitePhase(sqliteTestPhases.independentWrite, () => {
      calls++;
      throw error;
    }),
    (actual) => actual === error,
  );
  assert.equal(calls, 1);
  assert.equal(error.code, "SQLITE_WRITE_OUTCOME_UNKNOWN");
  assert(error.message.includes('"operationStage":"commit-complete"'));
  assert(!error.message.includes("PRIVATE_"));
  assert(Buffer.byteLength(error.message) < 2048);
});
