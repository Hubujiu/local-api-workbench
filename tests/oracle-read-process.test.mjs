import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { runOracleReadOwned } from "../src/oracle-read-supervisor.mjs";

const fixture = new URL(
  "./fixtures/oracle-read-worker-fake.mjs",
  import.meta.url,
);
const input = (service = "FREEPDB1") => ({
  host: "db.example.test",
  port: 1521,
  service,
  user: "reader",
  password: "fixture-only",
  ssl: true,
  sql: "SELECT 1 FROM DUAL",
});
function factory(observed) {
  return (_url, options) => {
    const child = fork(fixture, [], options);
    observed.child = child;
    child.once("close", () => {
      observed.closed = true;
    });
    return child;
  };
}

test(
  "owned fake-driver process exits naturally before success, with no ambient environment",
  { timeout: 5000 },
  async () => {
    const observed = {};
    const result = await runOracleReadOwned(input(), {
      createWorker: factory(observed),
    });
    assert.equal(observed.closed, true);
    assert.deepEqual(result, {
      columns: ["VALUE"],
      rows: [{ VALUE: "1" }],
      truncated: false,
      limit: 1000,
    });
  },
);

test(
  "abort of idle fake-driver fetch waits for actual owned process close",
  { timeout: 5000 },
  async () => {
    const observed = {},
      controller = new AbortController();
    const pending = runOracleReadOwned(input("HANG"), {
      signal: controller.signal,
      createWorker: factory(observed),
    });
    const rejection = assert.rejects(pending, { code: "ORACLE_WIP_CANCELLED" });
    observed.child.on("message", (message) => {
      if (message.kind === "oracle-phase" && message.phase === "query")
        controller.abort();
    });
    await rejection;
    assert.equal(observed.closed, true);
    assert.equal(observed.child.signalCode, "SIGKILL");
  },
);

test(
  "cleanup deadline reaps fake leftover handles rather than delivering early success",
  { timeout: 6000 },
  async () => {
    const observed = {};
    await assert.rejects(
      runOracleReadOwned(input("LINGER"), { createWorker: factory(observed) }),
      { code: "ORACLE_WIP_TIMEOUT" },
    );
    assert.equal(observed.closed, true);
    assert.equal(observed.child.signalCode, "SIGKILL");
  },
);

test(
  "after terminal result, IPC loss still terminates a lingering fake worker",
  { timeout: 5000 },
  async () => {
    const child = fork(fixture, [], {
      execPath: process.execPath,
      execArgv: [],
      env: {},
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    // This test deliberately closes IPC itself; observe the emergency process
    // exit. Normal supervisor tests above separately require process close.
    const exited = once(child, "exit");
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      child.on("message", (message) => {
        if (message.kind === "oracle-result") child.disconnect();
      });
      child.send(input("LINGER"));
      const [code, signal] = await exited;
      assert.equal(signal, null);
      assert.equal(code, 1);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  },
);
