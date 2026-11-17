import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  sqliteTestPhases,
  withSQLitePhase,
} from "./helpers/sqlite-phase-diagnostics.mjs";

const marker = "\nSQLITE_PHASE_METADATA ";
const secret = "PRIVATE_SQL_PATH_PARAMS_CREDENTIAL_SENTINEL";
const phase = sqliteTestPhases.independentWrite;
function failure(diagnostics = {}) {
  const error = new Error("original failure");
  error.code = "SQLITE_WRITE_OUTCOME_UNKNOWN";
  error.diagnostics = diagnostics;
  return error;
}
function metadata(error) {
  const suffix = error.message.slice(error.message.indexOf(marker));
  assert(suffix.startsWith(marker));
  assert(Buffer.byteLength(suffix, "utf8") <= 2048);
  assert(!suffix.includes(secret));
  return JSON.parse(suffix.slice(marker.length));
}
async function rejectsSame(error, ...labels) {
  const label = labels.length ? labels[0] : phase;
  let calls = 0,
    caught = false;
  try {
    await withSQLitePhase(label, () => {
      calls++;
      throw error;
    });
  } catch (actual) {
    caught = true;
    assert.equal(actual, error);
  }
  assert.equal(caught, true);
  assert.equal(calls, 1);
}

test("phase diagnostics preserve successful sync and async values with one callback", async () => {
  for (const label of Object.values(sqliteTestPhases)) {
    const value = { unchanged: true };
    let calls = 0;
    assert.equal(
      await withSQLitePhase(label, () => {
        calls++;
        return value;
      }),
      value,
    );
    assert.equal(
      await withSQLitePhase(label, async () => {
        calls++;
        return value;
      }),
      value,
    );
    assert.equal(calls, 2);
  }
});

test("independent-write rejection retains identity, code, stack, cause and valid evidence", async () => {
  const diagnostics = {
    phase: "worker-ready",
    elapsedMs: 2001,
    timeout: true,
    exitCode: 1,
    signal: "SIGKILL",
    receivedResult: false,
    spawnErrorCode: "EAGAIN",
    processErrorCode: "EPERM",
    sendErrorCode: "ERR_IPC_CHANNEL_CLOSED",
    workerErrorCode: "ERR_WORKER_OUT_OF_MEMORY",
    workerExitCode: -1,
    supervisorReadyMs: 12,
    workerReadyMs: 21,
    resultReceivedMs: null,
  };
  const error = failure(diagnostics),
    cause = { untouched: true };
  error.cause = cause;
  const stack = error.stack;
  const stackDescriptor = Object.getOwnPropertyDescriptor(error, "stack");
  let calls = 0;
  await assert.rejects(
    withSQLitePhase(phase, async () => {
      calls++;
      throw error;
    }),
    (actual) => actual === error,
  );
  assert.equal(calls, 1);
  assert.equal(error.stack, stack);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(error, "stack"),
    stackDescriptor,
  );
  assert.equal(error.cause, cause);
  assert.equal(error.diagnostics, diagnostics);
  assert.equal(error.code, "SQLITE_WRITE_OUTCOME_UNKNOWN");
  assert(error.message.startsWith("original failure" + marker));
  assert.deepEqual(metadata(error), {
    phase,
    code: error.code,
    diagnostics,
  });
});

test("sync assertion failures retain assertion fields and receive phase only", async () => {
  let error;
  try {
    assert.equal(1, 2, "unchanged assertion");
  } catch (caught) {
    error = caught;
  }
  const before = Object.getOwnPropertyDescriptors(error);
  await rejectsSame(error, sqliteTestPhases.recoveryOpenRead);
  const after = Object.getOwnPropertyDescriptors(error);
  delete before.message;
  delete after.message;
  assert.deepEqual(after, before);
  assert.deepEqual(metadata(error), {
    phase: sqliteTestPhases.recoveryOpenRead,
  });
});

test("error and diagnostic accessors are never invoked, including lazy stack", async () => {
  let reads = 0;
  const accessor = {
    configurable: true,
    get() {
      reads++;
      throw new Error("getter must not run");
    },
  };
  for (const key of ["diagnostics", "code", "stack", "cause", "toJSON"]) {
    const error = failure({ elapsedMs: 4 });
    Object.defineProperty(error, key, accessor);
    await rejectsSame(error);
    assert.equal(metadata(error).phase, phase);
  }
  const diagnostics = {};
  for (const key of [
    "phase",
    "elapsedMs",
    "timeout",
    "exitCode",
    "signal",
    "receivedResult",
    "spawnErrorCode",
    "processErrorCode",
    "sendErrorCode",
    "workerErrorCode",
    "workerExitCode",
    "supervisorReadyMs",
    "workerReadyMs",
    "resultReceivedMs",
    "toJSON",
  ])
    Object.defineProperty(diagnostics, key, accessor);
  const error = failure(diagnostics);
  await rejectsSame(error);
  assert.equal(metadata(error).diagnostics.phase, "unknown");
  assert.equal(reads, 0);
});

test("proxies and revoked proxies are skipped without any trap", async () => {
  let traps = 0;
  const trap = () => {
    traps++;
    throw new Error("proxy trap must not run");
  };
  const handler = {
    get: trap,
    getOwnPropertyDescriptor: trap,
    getPrototypeOf: trap,
    ownKeys: trap,
    set: trap,
    defineProperty: trap,
    isExtensible: trap,
    has: trap,
  };
  const proxy = new Proxy(failure(), handler);
  await rejectsSame(proxy);
  const revoked = Proxy.revocable(failure(), handler);
  revoked.revoke();
  await rejectsSame(revoked.proxy);
  for (const source of [proxy, revoked.proxy]) {
    const error = failure(source);
    await rejectsSame(error);
    assert.deepEqual(metadata(error), { phase });
  }
  const diagnostics = Object.create(proxy);
  Object.defineProperty(diagnostics, "elapsedMs", { value: 3 });
  const error = failure(diagnostics);
  await rejectsSame(error);
  assert.equal(metadata(error).diagnostics.elapsedMs, 3);
  assert.equal(traps, 0);
});

test("cycles, unknown keys, secrets, huge values and coercion hooks cannot enter suffix", async () => {
  let hooks = 0;
  const hostile = {
    toJSON() {
      hooks++;
      throw new Error("toJSON must not run");
    },
    [Symbol.toPrimitive]() {
      hooks++;
      throw new Error("coercion must not run");
    },
  };
  const diagnostics = {
    phase: secret.repeat(10000),
    elapsedMs: hostile,
    timeout: hostile,
    exitCode: 2n,
    signal: Symbol(secret),
    receivedResult: "true",
    spawnErrorCode: secret,
    processErrorCode: hostile,
    sendErrorCode: () => secret,
    workerErrorCode: secret.repeat(10000),
    workerExitCode: Number.MAX_SAFE_INTEGER,
    supervisorReadyMs: Infinity,
    workerReadyMs: NaN,
    resultReceivedMs: -1,
    sql: secret,
    path: secret,
    parameters: [secret],
    credentials: secret,
    message: secret,
    stack: secret,
    toJSON: hostile.toJSON,
  };
  diagnostics.cycle = diagnostics;
  const error = failure(diagnostics);
  error.message = secret;
  error.cause = hostile;
  error.toJSON = hostile.toJSON;
  await rejectsSame(error);
  assert(error.message.startsWith(secret + marker));
  assert.deepEqual(metadata(error), {
    phase,
    code: "SQLITE_WRITE_OUTCOME_UNKNOWN",
    diagnostics: {
      phase: "unknown",
      elapsedMs: null,
      timeout: false,
      exitCode: null,
      signal: null,
      receivedResult: false,
      spawnErrorCode: "OTHER",
      processErrorCode: null,
      sendErrorCode: null,
      workerErrorCode: "OTHER",
      workerExitCode: null,
      supervisorReadyMs: null,
      workerReadyMs: null,
      resultReceivedMs: null,
    },
  });
  assert.equal(hooks, 0);
});

test("numeric boundaries are bounded and unknown enum values are redacted", async () => {
  for (const [input, expected] of [
    [0, 0],
    [86400000, 86400000],
    [86400001, null],
    [-1, null],
    [1.5, null],
    ["100", null],
  ]) {
    const error = failure({ elapsedMs: input });
    await rejectsSame(error);
    assert.equal(metadata(error).diagnostics.elapsedMs, expected);
  }
  for (const [input, expected] of [
    [-4294967295, -4294967295],
    [4294967295, 4294967295],
    [4294967296, null],
    [Infinity, null],
    [false, null],
  ]) {
    const error = failure({ exitCode: input });
    await rejectsSame(error);
    assert.equal(metadata(error).diagnostics.exitCode, expected);
  }
  for (const code of ["SQLITE_QUERY_TIMEOUT", "SQLITE_QUERY_PROCESS_FAILED"]) {
    const error = failure({ phase: "worker-result", signal: "SIGTERM" });
    error.code = code;
    await rejectsSame(error);
    assert.equal(metadata(error).code, code);
    assert.equal(metadata(error).diagnostics.phase, "worker-result");
    assert.equal(metadata(error).diagnostics.signal, "SIGTERM");
  }
  const error = failure({ phase: secret, signal: secret });
  error.code = secret;
  await rejectsSame(error);
  assert.deepEqual(metadata(error), { phase });
});

test("even an inherited toJSON hook is not invoked for the safe suffix", async () => {
  let calls = 0;
  const before = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  const error = failure({ elapsedMs: 5 });
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    value() {
      calls++;
      throw new Error("inherited toJSON must not run");
    },
  });
  try {
    await rejectsSame(error);
  } finally {
    if (before) Object.defineProperty(Object.prototype, "toJSON", before);
    else delete Object.prototype.toJSON;
  }
  assert.equal(calls, 0);
  assert.equal(metadata(error).diagnostics.elapsedMs, 5);
});

test("unsupported and frozen errors retain their original throw without mutation", async () => {
  let reads = 0;
  const accessorError = failure();
  Object.defineProperty(accessorError, "message", {
    get() {
      reads++;
      throw new Error("message getter must not run");
    },
  });
  const readOnlyError = failure();
  Object.defineProperty(readOnlyError, "message", { writable: false });
  const missingMessage = new Error();
  const frozen = Object.freeze(failure());
  for (const error of [accessorError, readOnlyError, missingMessage, frozen]) {
    const before = Object.getOwnPropertyDescriptors(error);
    await rejectsSame(error);
    assert.deepEqual(Object.getOwnPropertyDescriptors(error), before);
  }
  for (const error of [undefined, null, secret, 1, 1n, Symbol(secret), {}])
    await rejectsSame(error);
  assert.equal(reads, 0);
});

test("only fixed phase labels can be appended", async () => {
  const error = failure();
  for (const label of [secret, {}, null, undefined]) {
    await rejectsSame(error, label);
    assert.equal(error.message, "original failure");
  }
  assert(Object.isFrozen(sqliteTestPhases));
});

test("Node TAP exposes phase and redacted evidence for a tiny fake rejection", () => {
  const helper = new URL(
    "./helpers/sqlite-phase-diagnostics.mjs",
    import.meta.url,
  );
  const script = `
    import test from 'node:test';
    import { withSQLitePhase, sqliteTestPhases } from ${JSON.stringify(helper.href)};
    test('fake SQLite failure, no database', async () => {
      const error = new Error('fake failure');
      error.code = 'SQLITE_WRITE_OUTCOME_UNKNOWN';
      error.diagnostics = { phase: 'worker-ready', elapsedMs: 2001, timeout: true, sql: ${JSON.stringify(secret)} };
      await withSQLitePhase(sqliteTestPhases.independentWrite, () => Promise.reject(error));
    });
  `;
  const env = { ...process.env };
  // This is a standalone TAP probe, not a child using the parent's internal
  // test-runner serialization protocol.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--test-reporter=tap", "-e", script],
    { encoding: "utf8", maxBuffer: 65536, env },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not ok 1/);
  assert.match(result.stdout, /SQLITE_PHASE_METADATA/);
  assert.match(result.stdout, /independent-write/);
  assert.match(result.stdout, /worker-ready/);
  assert.match(result.stdout, /SQLITE_WRITE_OUTCOME_UNKNOWN/);
  assert(!result.stdout.includes(secret));
  assert(!result.stderr.includes(secret));
});
