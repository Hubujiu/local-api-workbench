import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runOracleReadOwned } from "../src/oracle-read-supervisor.mjs";

const input = () => ({
  host: "db.example.test",
  port: 1521,
  service: "FREEPDB1",
  user: "reader",
  password: "secret",
  ssl: true,
  sql: "SELECT 1 FROM DUAL",
  parameters: [],
});
const result = () => ({
  columns: ["VALUE"],
  rows: [{ VALUE: "1" }],
  truncated: false,
  limit: 1000,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  const worker = new EventEmitter(),
    timers = new Set(),
    observed = {};
  worker.kill = (signal) => {
    assert.equal(signal, "SIGKILL");
    observed.terminated = (observed.terminated || 0) + 1;
    return true;
  };
  worker.send = (value, callback) => {
    observed.input = value;
    callback?.();
  };

  return {
    worker,
    timers,
    observed,
    options: {
      createWorker(url, options) {
        observed.url = url;
        observed.options = options;
        observed.created = (observed.created || 0) + 1;
        return worker;
      },
      setTimer(fn, ms) {
        const timer = { fn, ms };
        timers.add(timer);
        return timer;
      },
      clearTimer(timer) {
        timers.delete(timer);
      },
    },
  };
}
function phase(worker, name) {
  worker.emit("message", { kind: "oracle-phase", phase: name });
}
function success(worker) {
  for (const name of ["connect", "setup", "classify", "query", "cleanup"])
    phase(worker, name);
  worker.emit("message", { kind: "oracle-result", result: result() });
}

test("pre-abort and invalid input allocate no worker", async () => {
  const h = harness(),
    c = new AbortController();
  c.abort();
  await assert.rejects(
    runOracleReadOwned(input(), { ...h.options, signal: c.signal }),
    { code: "ORACLE_WIP_CANCELLED" },
  );
  await assert.rejects(
    runOracleReadOwned({ ...input(), ssl: false }, h.options),
  );
  await assert.rejects(
    runOracleReadOwned(
      { ...input(), caCertificatePem: "/tmp/ca.pem" },
      h.options,
    ),
  );
  assert.equal(h.observed.created, undefined);
  assert.equal(h.timers.size, 0);
});

test("worker gets isolated environment/arguments/output, and result waits for actual exit", async () => {
  const h = harness();
  let settled = false;
  const p = runOracleReadOwned(input(), h.options).then((value) => {
    settled = true;
    return value;
  });
  assert.equal(h.observed.options.execPath, process.execPath);
  assert.deepEqual(h.observed.options.env, { NODE_V8_COVERAGE: "" });
  assert.deepEqual(h.observed.options.execArgv, []);
  assert.deepEqual(h.observed.options.stdio, [
    "ignore",
    "ignore",
    "ignore",
    "ipc",
  ]);
  assert.equal(h.observed.input.password, "secret");
  assert.ok(h.timers.size === 2);
  success(h.worker);
  await tick();
  assert.equal(settled, false);
  assert.equal(h.timers.size, 2);
  h.worker.emit("close", 0, null);
  assert.deepEqual(await p, result());
  assert.equal(h.timers.size, 0);
  assert.equal(h.observed.terminated, undefined);
});

test("abort owns only this worker and must observe exit instead of treating kill acknowledgement as closure", async () => {
  const h = harness(),
    other = harness(),
    c = new AbortController();
  let settled = false;
  const p = runOracleReadOwned(input(), {
    ...h.options,
    signal: c.signal,
  }).catch((error) => {
    settled = true;
    return error;
  });
  const q = runOracleReadOwned(input(), other.options);
  c.abort();
  await tick();
  assert.equal(settled, false);
  assert.equal(h.observed.terminated, 1);
  assert.equal(other.observed.terminated, undefined);
  success(h.worker);
  h.worker.emit("close", 0, null);
  assert.equal((await p).code, "ORACLE_WIP_CANCELLED");
  success(other.worker);
  other.worker.emit("close", 0, null);
  assert.deepEqual(await q, result());
  assert.equal(h.observed.created, 1);
  assert.equal(h.timers.size, 0);
});

test("connection, query, cleanup and total deadlines terminate without adapter replay", async () => {
  for (const target of ["connect", "query", "cleanup", "total"]) {
    const h = harness();
    let settled = false;
    const p = runOracleReadOwned(input(), h.options).catch((error) => {
      settled = true;
      return error;
    });
    if (target === "query" || target === "cleanup")
      for (const name of ["connect", "setup", "classify", "query"])
        phase(h.worker, name);
    if (target === "cleanup") {
      phase(h.worker, "cleanup");
      h.worker.emit("message", { kind: "oracle-result", result: result() });
    }
    const timer = [...h.timers].find(
      (x) =>
        x.ms ===
        (target === "total" ? 8000 : target === "connect" ? 3000 : 2000),
    );
    assert.ok(timer);
    timer.fn();
    await tick();
    assert.equal(settled, false);
    assert.equal(h.observed.terminated, 1);
    h.worker.emit("close", null, "SIGKILL");
    assert.equal((await p).code, "ORACLE_WIP_TIMEOUT");
    assert.equal(h.observed.created, 1);
    assert.equal(h.timers.size, 0);
  }
});

test("malformed, premature, duplicate, oversized result and nonzero exit fail closed", async () => {
  for (const event of [
    "premature",
    "cleanupOnly",
    "setupFirst",
    "duplicate",
    "oversized",
    "phase",
    "nonzero",
    "noresult",
    "error",
  ]) {
    const h = harness();
    const p = runOracleReadOwned(input(), h.options).catch((error) => error);
    if (event === "premature")
      h.worker.emit("message", { kind: "oracle-result", result: result() });
    if (event === "phase") phase(h.worker, "query");
    if (event === "setupFirst") phase(h.worker, "setup");
    if (event === "cleanupOnly") {
      phase(h.worker, "cleanup");
      h.worker.emit("message", { kind: "oracle-result", result: result() });
    }
    if (event === "duplicate") {
      success(h.worker);
      h.worker.emit("message", { kind: "oracle-result", result: result() });
    }
    if (event === "oversized") {
      for (const name of ["connect", "setup", "classify", "query", "cleanup"])
        phase(h.worker, name);
      const value = result();
      value.rows[0].VALUE = "x".repeat(1024 * 1024);
      h.worker.emit("message", { kind: "oracle-result", result: value });
    }
    if (event === "error")
      h.worker.emit("error", Error("secret sql and password"));
    if (event === "nonzero") success(h.worker);
    h.worker.emit("close", event === "nonzero" ? 1 : 0, null);
    const error = await p;
    assert.equal(error.code, "ORACLE_WIP_WORKER_FAILED");
    assert.ok(!error.message.includes("secret"));
  }
});

test("worker query failure is sanitized and waits for exit; startup throw leaves no timers", async () => {
  const h = harness();
  let settled = false;
  const p = runOracleReadOwned(input(), h.options).catch((error) => {
    settled = true;
    return error;
  });
  phase(h.worker, "cleanup");
  h.worker.emit("message", {
    kind: "oracle-error",
    code: "ORACLE_WIP_QUERY_FAILED",
    message: "secret",
  });
  await tick();
  assert.equal(settled, false);
  h.worker.emit("close", 0, null);
  assert.equal((await p).code, "ORACLE_WIP_QUERY_FAILED");
  const other = harness();
  await assert.rejects(
    runOracleReadOwned(input(), {
      ...other.options,
      createWorker() {
        throw Error("secret");
      },
    }),
    { code: "ORACLE_WIP_WORKER_FAILED" },
  );
  assert.equal(other.timers.size, 0);
});

test("IPC collector rejects empty/sparse/malformed columns and noncanonical blobs", async () => {
  for (const value of [
    { ...result(), columns: [], rows: [{}] },
    { ...result(), columns: new Array(1), rows: [] },
    { ...result(), columns: ["\ud800"], rows: [{ "\ud800": "1" }] },
    { ...result(), rows: [{ VALUE: "\ud800" }] },
    {
      ...result(),
      rows: [{ VALUE: { type: "blob", base64: "not canonical!" } }],
    },
  ]) {
    const h = harness();
    const pending = runOracleReadOwned(input(), h.options).catch(
      (error) => error,
    );
    for (const name of ["connect", "setup", "classify", "query", "cleanup"])
      phase(h.worker, name);
    h.worker.emit("message", { kind: "oracle-result", result: value });
    h.worker.emit("close", 0, null);
    assert.equal((await pending).code, "ORACLE_WIP_WORKER_FAILED");
  }
});
