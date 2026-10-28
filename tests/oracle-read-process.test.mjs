import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { readFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { runOracleReadOwned } from "../src/oracle-read-supervisor.mjs";
import {
  allowedFixtureEnvironmentKey,
  sentinelKey,
} from "./fixtures/oracle-read-worker-environment.mjs";

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
function collectDiagnostic(child, observed, t) {
  let size = 0,
    chunks = [];
  observed.diagnosticDone = new Promise((resolve) => {
    // Always drain, but retain at most 4 KiB. Never echo raw stderr, errors or
    // unvalidated JSON; a leaked startup warning must not become a test log.
    child.stderr.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 4096) chunks.push(chunk);
    });
    child.stderr.once("end", () => {
      try {
        if (size > 4096) throw Error();
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.split("\n").length !== 2 || !text.endsWith("\n"))
          throw Error();
        const d = JSON.parse(text);
        if (
          Object.keys(d).sort().join(",") !==
            "coverageEmpty,environmentKeyCount,environmentKeys,execArgvCount,kind,node,platform,sentinelPresent" ||
          d.kind !== "oracle-fixture-environment" ||
          !/^[a-z0-9]{1,16}$/.test(d.platform) ||
          !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(d.node) ||
          !Array.isArray(d.environmentKeys) ||
          d.environmentKeys.length > 32 ||
          !d.environmentKeys.every(
            (key) =>
              typeof key === "string" &&
              (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ||
                key === "<invalid-key>"),
          ) ||
          !Number.isSafeInteger(d.environmentKeyCount) ||
          d.environmentKeyCount < 0 ||
          !Number.isSafeInteger(d.execArgvCount) ||
          d.execArgvCount < 0 ||
          typeof d.sentinelPresent !== "boolean" ||
          typeof d.coverageEmpty !== "boolean"
        )
          throw Error();
        observed.diagnostic = d;
        t.diagnostic(JSON.stringify(d));
      } catch {
        t.diagnostic(
          "Oracle fixture: missing or invalid bounded KEY-only diagnostic",
        );
      }
      chunks = [];
      resolve();
    });
  });
}

function forkPoisonedFixture(options, observed, t) {
  const root = mkdtempSync(join(tmpdir(), "oracle-worker-env-"));
  const poison = {
    [sentinelKey]: "fixture-parent-only",
    NODE_V8_COVERAGE: join(root, "coverage"),
    NODE_COMPILE_CACHE: join(root, "compile-cache"),
    NODE_OPTIONS: "--trace-warnings",
    NODE_DEBUG: "tls,net",
    NODE_DEBUG_NATIVE: "tls",
    NODE_EXTRA_CA_CERTS: join(root, "missing-ca.pem"),
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NODE_USE_SYSTEM_CA: "1",
    NODE_ORACLEDB_DEBUG_PACKETS: "1",
    ORA_DEBUG_JDWP: "fixture-parent-only",
    TNS_ADMIN: join(root, "missing-tns"),
    ORACLE_HOME: join(root, "missing-client"),
    ORACLE_SID: "fixture-parent-only",
    ORACLE_USER: "fixture-parent-only",
    ORACLE_PASSWORD: "fixture-parent-only",
    SSL_CERT_FILE: join(root, "missing-ca.pem"),
    SSL_CERT_DIR: join(root, "missing-ca-directory"),
  };
  const saved = new Map(
    Object.keys(poison).map((key) => [key, process.env[key]]),
  );
  let child;
  try {
    for (const [key, value] of Object.entries(poison)) process.env[key] = value;
    // Sole test override: pipe stderr for a bounded KEY-only observation. The
    // production constructor's environment, arguments and other stdio stand.
    child = fork(fixture, [], {
      ...options,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    observed.parentRestored = [...saved].every(
      ([key, value]) => process.env[key] === value,
    );
    if (!child) rmSync(root, { recursive: true, force: true });
  }
  observed.child = child;
  collectDiagnostic(child, observed, t);
  let cleaned = false;
  const cleanFixtureDirectory = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      observed.coverageFileCount = readdirSync(root).length;
    } catch {
      observed.coverageFileCount = -1;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  child.once("exit", cleanFixtureDirectory);
  child.once("close", () => {
    observed.closed = true;
    cleanFixtureDirectory();
  });
  return child;
}
function factory(observed, t) {
  return (_url, options) => forkPoisonedFixture(options, observed, t);
}
async function assertIsolated(observed) {
  await observed.diagnosticDone;
  const d = observed.diagnostic;
  assert.ok(d, "expected bounded fixture environment diagnostic");
  assert.equal(d.platform, process.platform);
  assert.equal(d.node, process.versions.node);
  assert.equal(d.environmentKeyCount, d.environmentKeys.length);
  assert.ok(
    d.environmentKeys.every((key) =>
      allowedFixtureEnvironmentKey(key, d.platform),
    ),
    "unexpected child environment key",
  );
  assert.equal(d.execArgvCount, 0);
  assert.equal(d.sentinelPresent, false);
  assert.equal(d.coverageEmpty, true);
  assert.equal(observed.parentRestored, true);
  assert.equal(observed.coverageFileCount, 0);
}

test(
  "custom CA is child-only, or fails closed when its public API is unavailable",
  { timeout: 5000 },
  async (t) => {
    const before = tls.getCACertificates("default"),
      observed = {};
    const caCertificatePem = readFileSync(
      new URL("./fixtures/localhost.crt", import.meta.url),
      "utf8",
    );
    const pending = runOracleReadOwned(
      { ...input("CUSTOM_CA"), caCertificatePem },
      { createWorker: factory(observed, t) },
    );
    if (typeof tls.setDefaultCACertificates === "function")
      assert.equal((await pending).rows[0].VALUE, "1");
    else await assert.rejects(pending, { code: "ORACLE_WIP_TLS_UNAVAILABLE" });
    assert.equal(observed.closed, true);
    assert.deepEqual(tls.getCACertificates("default"), before);
    await assertIsolated(observed);
  },
);

test(
  "owned fake-driver process exits naturally without parent credential/debug/TLS environment",
  { timeout: 5000 },
  async (t) => {
    const observed = {};
    const result = await runOracleReadOwned(input(), {
      createWorker: factory(observed, t),
    });
    assert.equal(observed.closed, true);
    assert.deepEqual(result, {
      columns: ["VALUE"],
      rows: [{ VALUE: "1" }],
      truncated: false,
      limit: 1000,
    });
    await assertIsolated(observed);
  },
);

test(
  "abort of idle fake-driver fetch waits for actual owned process close",
  { timeout: 5000 },
  async (t) => {
    const observed = {},
      controller = new AbortController();
    const pending = runOracleReadOwned(input("HANG"), {
      signal: controller.signal,
      createWorker: factory(observed, t),
    });
    const rejection = assert.rejects(pending, { code: "ORACLE_WIP_CANCELLED" });
    observed.child.on("message", (message) => {
      if (message.kind === "oracle-phase" && message.phase === "query")
        controller.abort();
    });
    await rejection;
    assert.equal(observed.closed, true);
    assert.equal(observed.child.signalCode, "SIGKILL");
    await assertIsolated(observed);
  },
);

test(
  "cleanup deadline reaps fake leftover handles rather than delivering early success",
  { timeout: 6000 },
  async (t) => {
    const observed = {};
    await assert.rejects(
      runOracleReadOwned(input("LINGER"), {
        createWorker: factory(observed, t),
      }),
      { code: "ORACLE_WIP_TIMEOUT" },
    );
    assert.equal(observed.closed, true);
    assert.equal(observed.child.signalCode, "SIGKILL");
    await assertIsolated(observed);
  },
);

test(
  "after terminal result, IPC loss still terminates a lingering fake worker",
  { timeout: 5000 },
  async (t) => {
    const observed = {};
    const child = forkPoisonedFixture(
      {
        execPath: process.execPath,
        execArgv: [],
        env: { NODE_V8_COVERAGE: "" },
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
      observed,
      t,
    );
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
      await assertIsolated(observed);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  },
);
