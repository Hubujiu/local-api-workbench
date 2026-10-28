// Standalone, explicitly authorized GitHub-CI acceptance, never core *.test.mjs.
// This imports the real Thin driver only in fresh diagnostic/adapter children.
// There is no TCP fallback, TLS override, private socket access, or TNS proxy.
import { fork, spawn } from "node:child_process";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { runOracleReadOwned } from "../src/oracle-read-supervisor.mjs";
import { oracleReadInput } from "../src/oracle-read-config.mjs";
import { loadOracleReadWorkerDriver } from "../src/oracle-read-worker-runtime.mjs";

const PIN =
  "container-registry.oracle.com/database/free:23.26.3.0-lite-amd64@sha256:770ca58ab319d8cfde610b0db25c06899ce0af9591c4addfa10d2cb8f0318e65";
const SELF = new URL(import.meta.url);
const CHILDREN = new Set();
const SAFE_TLS_RESULTS = new Set([
  "connected",
  "tls-chain-rejected",
  "tls-hostname-rejected",
  "unexpected-failure",
]);
const check = (condition) => {
  if (!condition) throw Error("ORACLE_CI_ASSERTION_FAILED");
};

function observe(child, observed = {}) {
  CHILDREN.add(child);
  observed.child = child;
  observed.phases = [];
  observed.resultMessages = 0;
  observed.closed = false;
  child.on("message", (message) => {
    if (message?.kind === "oracle-phase") observed.phases.push(message.phase);
    if (message?.kind === "oracle-result") observed.resultMessages++;
  });
  child.once("close", (code, signal) => {
    observed.closed = true;
    observed.code = code;
    observed.signal = signal;
    CHILDREN.delete(child);
  });
  return child;
}

function workerFactory(observed, onPhase) {
  return (url, options) => {
    // Preserve the production URL, executable, environment, arguments and stdio.
    // The seam only observes public ChildProcess events; no fake worker/driver.
    const child = observe(fork(url, [], options), observed);
    child.on("message", (message) => {
      if (message?.kind === "oracle-phase") onPhase?.(message.phase);
    });
    return child;
  };
}

async function owned(input, options = {}) {
  const observed = {};
  const result = await runOracleReadOwned(input, {
    ...options,
    createWorker: workerFactory(observed),
  });
  check(observed.closed && observed.code === 0 && !observed.signal);
  check(observed.resultMessages === 1);
  return result;
}

async function rejected(input, { beforeQuery = false } = {}) {
  const observed = {};
  let error, returned;
  try {
    returned = await runOracleReadOwned(input, {
      createWorker: workerFactory(observed),
    });
  } catch (value) {
    error = value;
  }
  check(error?.code === "ORACLE_WIP_QUERY_FAILED");
  check(returned === undefined && observed.resultMessages === 0);
  check(observed.closed && observed.code === 0 && !observed.signal);
  if (beforeQuery) check(!observed.phases.includes("query"));
  // The public boundary must not contain driver messages, SQL or credentials.
  check(
    error.message ===
      "Oracle WIP read failed; adapter will not retry or replay",
  );
  return observed;
}

function classifyTLS(error) {
  // Read only public errors from the exact pinned driver. Raw text never leaves
  // this process. Unrecognized errors fail acceptance instead of counting as TLS.
  const message = typeof error?.message === "string" ? error.message : "";
  if (!/\bNJS-506\b/.test(message)) return "unexpected-failure";
  if (/\bNJS-508\b/.test(message)) return "tls-hostname-rejected";
  if (
    /self[- ]signed certificate|unable to verify the first certificate|unable to get (?:local )?issuer certificate/i.test(
      message,
    )
  )
    return "tls-chain-rejected";
  return "unexpected-failure";
}

function diagnosticChild() {
  check(typeof process.send === "function");
  const watchdog = setTimeout(() => process.exit(1), 6500);
  watchdog.unref();
  process.once("disconnect", () => process.exit(1));
  process.once("message", async (input) => {
    let connection,
      category = "unexpected-failure";
    try {
      const { connectionOptions } = oracleReadInput(input);
      const { driver } = await loadOracleReadWorkerDriver(
        input,
        async () => (await import("oracledb")).default,
      );
      check(driver.thin === true && driver.versionString === "26.0.0");
      connection = await driver.getConnection(connectionOptions);
      check(connection.thin === true);
      category = "connected";
    } catch (error) {
      category = classifyTLS(error);
    } finally {
      try {
        await connection?.close();
      } catch {
        category = "unexpected-failure";
      }
    }
    process.send({ kind: "oracle-tls-diagnostic", category }, (error) => {
      if (error) process.exit(1);
      // Natural process/IPC close, not an early force-success exit.
      process.channel?.unref();
    });
  });
}

function tlsDiagnostic(input) {
  return new Promise((resolve, reject) => {
    const observed = {},
      messages = [];
    const child = observe(
      fork(SELF, ["--tls-diagnostic"], {
        execPath: process.execPath,
        execArgv: [],
        env: {
          GITHUB_ACTIONS: "true",
          ORACLE_TCPS_ACCEPTANCE: "1",
          NODE_V8_COVERAGE: "",
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
      }),
      observed,
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 7000);
    child.on("error", () => child.kill("SIGKILL"));
    child.on("message", (message) => messages.push(message));
    child.once("close", () => {
      clearTimeout(timer);
      if (
        !observed.closed ||
        observed.code !== 0 ||
        observed.signal ||
        messages.length !== 1 ||
        messages[0]?.kind !== "oracle-tls-diagnostic" ||
        !SAFE_TLS_RESULTS.has(messages[0]?.category)
      ) {
        reject(Error("ORACLE_CI_TLS_DIAGNOSTIC_FAILED"));
        return;
      }
      resolve(messages[0].category);
    });
    child.send(input, (error) => {
      if (error) child.kill("SIGKILL");
    });
  });
}

function fixtureCommand(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["scripts/oracle-tcps-ci.py", ...args], {
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env,
    });
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      args[0] === "certificate" ? 210000 : 45000,
    );
    child.once("error", () => {
      clearTimeout(timer);
      reject(Error("ORACLE_CI_FIXTURE_COMMAND_FAILED"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal)
        reject(Error("ORACLE_CI_FIXTURE_COMMAND_FAILED"));
      else resolve();
    });
  });
}

function exactDecimal(value) {
  // Compare arbitrary precision decimal spellings without IEEE-754 coercion.
  check(typeof value === "string" && value.length <= 512);
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/.exec(value);
  check(match && (match[2].length || match[3]?.length));
  let digits = (match[2] + (match[3] || "")).replace(/^0+/, "");
  let exponent = Number(match[4] || "0") - (match[3]?.length || 0);
  check(Math.abs(exponent) <= 1024);
  if (!digits) return "0";
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    exponent++;
  }
  return `${match[1] === "-" ? "-" : ""}${digits}e${exponent}`;
}

async function main() {
  check(process.platform === "linux" && process.arch === "x64");
  check(Number(process.versions.node.split(".")[0]) === 24);
  check(typeof tls.setDefaultCACertificates === "function");
  const stateDir = await realpath(process.env.ORACLE_CI_STATE_DIR || "");
  const dirInfo = await stat(stateDir);
  check(dirInfo.isDirectory() && (dirInfo.mode & 0o077) === 0);
  check(dirInfo.uid === process.getuid());
  const statePath = path.join(stateDir, "state.json");
  const stateInfo = await stat(statePath);
  check(stateInfo.isFile() && stateInfo.size < 16384);
  check((stateInfo.mode & 0o077) === 0 && stateInfo.uid === process.getuid());
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const runnerTemp = await realpath(process.env.RUNNER_TEMP || "");
  const evidenceDir = await realpath(state.evidenceDirectory);
  check(evidenceDir === path.join(runnerTemp, "oracle-tcps-evidence"));
  const evidenceInfo = await stat(evidenceDir);
  check(evidenceInfo.isDirectory() && evidenceInfo.uid === process.getuid());
  check(state.pin === PIN && state.service === "FREEPDB1");
  check(
    state.reader === "CI_READER" && typeof state.readerPassword === "string",
  );
  check(Number.isInteger(state.port) && state.port > 0 && state.port <= 65535);
  check(state.caFile === "ca-a.crt" && state.wrongCaFile === "ca-b.crt");
  const trusted = await readFile(path.join(stateDir, state.caFile), "utf8");
  const untrusted = await readFile(
    path.join(stateDir, state.wrongCaFile),
    "utf8",
  );
  const initialTrust = tls.getCACertificates("default");
  const base = {
    host: "127.0.0.1",
    port: state.port,
    service: state.service,
    user: state.reader,
    password: state.readerPassword,
    ssl: true,
    caCertificatePem: trusted,
  };
  const positiveSQL =
    "SELECT ID, TXT, SYS_CONTEXT('USERENV','NETWORK_PROTOCOL') AS PROTOCOL " +
    "FROM CI_OWNER.CI_VALUES WHERE ID = 1";
  const request = (sql = positiveSQL, parameters = []) => ({
    ...base,
    sql,
    parameters,
  });
  const results = [];
  let stage = "initial",
    success = false;
  async function step(name, task) {
    stage = name;
    const details = await task();
    results.push({ name, status: "passed", ...(details ? { details } : {}) });
    console.log(`ORACLE_TCPS_CASE_PASS ${name}`);
  }
  async function positive() {
    const result = await owned(request());
    check(result.rows.length === 1 && result.rows[0].ID === "1");
    check(result.rows[0].TXT === "oracle-ci");
    check(result.rows[0].PROTOCOL?.toLowerCase() === "tcps");
    check(!result.truncated && result.limit === 1000);
  }
  try {
    await step("trusted-ca-positive", async () => {
      check((await tlsDiagnostic(request())) === "connected");
      await positive();
      return { driverTLS: "connected", adapterProtocol: "tcps" };
    });
    await step("no-ca-chain-rejection", async () => {
      const input = request();
      delete input.caCertificatePem;
      check((await tlsDiagnostic(input)) === "tls-chain-rejected");
      await rejected(input, { beforeQuery: true });
      return { driverTLS: "tls-chain-rejected", adapterBeforeQuery: true };
    });
    await step("wrong-ca-chain-rejection", async () => {
      const input = { ...request(), caCertificatePem: untrusted };
      check((await tlsDiagnostic(input)) === "tls-chain-rejected");
      await rejected(input, { beforeQuery: true });
      return { driverTLS: "tls-chain-rejected", adapterBeforeQuery: true };
    });
    await step("wrong-san-hostname-rejection", async () => {
      await fixtureCommand("certificate", "wrong");
      try {
        check((await tlsDiagnostic(request())) === "tls-hostname-rejected");
        await rejected(request(), { beforeQuery: true });
      } finally {
        await fixtureCommand("certificate", "good");
      }
      return { driverTLS: "tls-hostname-rejected", adapterBeforeQuery: true };
    });
    await step("positive-recovery", positive);
    await step("invalid-scalars-rejected-before-child-allocation", async () => {
      let allocations = 0;
      for (const value of [
        "x".repeat(1024 * 1024 + 1),
        Buffer.alloc(1024 * 1024 + 1),
        Number.MAX_SAFE_INTEGER + 1,
        { type: "int64", value: "9223372036854775808" },
        true,
      ]) {
        let failed = false;
        try {
          await runOracleReadOwned(request(positiveSQL, [value]), {
            createWorker: () => {
              allocations++;
              throw Error("ORACLE_CI_UNEXPECTED_ALLOCATION");
            },
          });
        } catch {
          failed = true;
        }
        check(failed && allocations === 0);
      }
      return { rejectedInputs: 5, childAllocations: allocations };
    });
    await step("exact-number-strings", async () => {
      const result = await owned(
        request(
          "SELECT DECIMAL_VALUE, BIG_VALUE, SMALL_VALUE, HUGE_VALUE FROM CI_OWNER.CI_VALUES WHERE ID=1",
        ),
      );
      const expected = {
        DECIMAL_VALUE: ".12345678901234567890123456789012345678",
        BIG_VALUE: "9007199254740993",
        SMALL_VALUE: "1e-130",
        HUGE_VALUE: "9.9999999999999999999999999999999999999e125",
      };
      check(result.rows.length === 1);
      for (const [key, value] of Object.entries(expected))
        check(exactDecimal(result.rows[0][key]) === exactDecimal(value));
    });
    await step("typed-input-binds-and-scalars", async () => {
      const result = await owned(
        request(
          "SELECT :1 AS SAFE_VALUE, :2 AS MIN_VALUE, :3 AS MAX_VALUE, " +
            ":4 AS RAW_VALUE, :5 AS TEXT_VALUE, :6 AS NULL_VALUE " +
            "FROM CI_OWNER.CI_VALUES WHERE ID=1",
          [
            Number.MAX_SAFE_INTEGER,
            { type: "int64", value: "-9223372036854775808" },
            { type: "int64", value: "9223372036854775807" },
            { type: "blob", base64: "AP+AQQ==" },
            "bound-text",
            null,
          ],
        ),
      );
      const row = result.rows[0];
      check(result.rows.length === 1 && row.SAFE_VALUE === "9007199254740991");
      check(row.MIN_VALUE === "-9223372036854775808");
      check(row.MAX_VALUE === "9223372036854775807");
      check(
        row.RAW_VALUE?.type === "blob" && row.RAW_VALUE.base64 === "AP+AQQ==",
      );
      check(row.TEXT_VALUE === "bound-text" && row.NULL_VALUE === null);
    });
    await step("raw-fixture", async () => {
      const result = await owned(
        request("SELECT RAW_VALUE FROM CI_OWNER.CI_VALUES WHERE ID=1"),
      );
      check(
        result.rows.length === 1 &&
          result.rows[0].RAW_VALUE?.base64 === "AP+AQQ==",
      );
    });
    await step("original-duplicate-alias-rejected", async () => {
      await rejected(
        request("SELECT ID AS DUP, TXT AS DUP FROM CI_OWNER.CI_VALUES"),
      );
    });
    await step("unsupported-describe-types-rejected", async () => {
      for (const column of ["DATE_VALUE", "CLOB_VALUE", "BLOB_VALUE"])
        await rejected(request(`SELECT ${column} FROM CI_OWNER.CI_VALUES`), {
          beforeQuery: true,
        });
    });
    await step("dml-plsql-for-update-rejected", async () => {
      for (const sql of [
        "UPDATE CI_OWNER.CI_VALUES SET TXT='not-allowed' WHERE ID=1",
        "DELETE FROM CI_OWNER.CI_VALUES WHERE ID=1",
        "BEGIN NULL; END;",
      ])
        await rejected(request(sql), { beforeQuery: true });
      await rejected(request("SELECT ID FROM CI_OWNER.CI_VALUES FOR UPDATE"));
      await positive();
    });
    await step("column-count-limit", async () => {
      const columns = Array.from(
        { length: 129 },
        (_, index) => `ID AS C${index}`,
      ).join(",");
      await rejected(request(`SELECT ${columns} FROM CI_OWNER.CI_VALUES`), {
        beforeQuery: true,
      });
    });
    await step("row-limit-1000-plus-one-probe", async () => {
      const result = await owned(
        request("SELECT ID FROM CI_OWNER.CI_ROWS ORDER BY ID"),
      );
      check(
        result.rows.length === 1000 &&
          result.truncated &&
          result.limit === 1000,
      );
      check(result.rows[0].ID === "1" && result.rows[999].ID === "1000");
    });
    await step("aggregate-byte-overflow-no-partial-result", async () => {
      await rejected(
        request("SELECT ID, TXT FROM CI_OWNER.CI_ROWS ORDER BY ID"),
      );
    });

    const busySQL =
      "SELECT SUM(MOD(A.ID * B.ID * C.ID, 997)) AS VALUE " +
      "FROM CI_OWNER.CI_ROWS A CROSS JOIN CI_OWNER.CI_ROWS B " +
      "CROSS JOIN CI_OWNER.CI_ROWS C WHERE C.ID <= 16";
    for (const kind of ["cancel", "timeout"]) {
      await step(
        `${kind}-real-child-close-other-request-survives`,
        async () => {
          const observed = {},
            controller = new AbortController();
          let survivor,
            abortTimer,
            querySeen = false,
            error,
            returned;
          const onPhase = (phase) => {
            if (phase !== "query" || querySeen) return;
            querySeen = true;
            // Start a genuinely separate request while the target query is active.
            survivor = positive();
            survivor.catch(() => {});
            if (kind === "cancel")
              abortTimer = setTimeout(() => controller.abort(), 150);
          };
          try {
            returned = await runOracleReadOwned(request(busySQL), {
              signal: controller.signal,
              createWorker: workerFactory(observed, onPhase),
              // A real, stricter query deadline avoids racing the driver's own
              // 2s callTimeout. This is not evidence of every natural network/auth
              // timeout, nor does it extend any production deadline.
              setTimer: (callback, milliseconds) =>
                setTimeout(
                  callback,
                  kind === "timeout" && observed.phases.at(-1) === "query"
                    ? Math.min(milliseconds, 250)
                    : milliseconds,
                ),
            });
          } catch (value) {
            error = value;
          } finally {
            clearTimeout(abortTimer);
          }
          check(querySeen && observed.closed && observed.signal === "SIGKILL");
          check(
            error?.code ===
              (kind === "cancel"
                ? "ORACLE_WIP_CANCELLED"
                : "ORACLE_WIP_TIMEOUT"),
          );
          check(returned === undefined && observed.resultMessages === 0);
          check(survivor !== undefined);
          await survivor;
          // Public fixture-side session observation; no client-private transport.
          await fixtureCommand("sessions-zero");
          await positive();
          return {
            queryPhaseObserved: true,
            ownedChildClosed: observed.closed,
            signal: observed.signal,
            resultMessages: observed.resultMessages,
            separateRequestSucceeded: true,
            readerSessionsAfterCleanup: 0,
            ...(kind === "timeout" ? { realQueryDeadlineMs: 250 } : {}),
          };
        },
      );
    }
    await step("child-trust-isolation-and-final-health", async () => {
      check(
        JSON.stringify(tls.getCACertificates("default")) ===
          JSON.stringify(initialTrust),
      );
      const input = request();
      delete input.caCertificatePem;
      check((await tlsDiagnostic(input)) === "tls-chain-rejected");
      await positive();
      await fixtureCommand("sessions-zero");
      check(CHILDREN.size === 0);
    });
    success = true;
    console.log("REAL_ORACLE_TCPS_REPRESENTATIVE_ACCEPTANCE_PASS");
  } finally {
    if (!success) console.error(`ORACLE_TCPS_CASE_FAIL ${stage}`);
    // Evidence is an explicitly allowlisted file, not an artifact of state/keys.
    await writeFile(
      path.join(evidenceDir, "integration.json"),
      JSON.stringify(
        {
          pin: PIN,
          node: process.versions.node,
          driver: "26.0.0",
          success,
          stage,
          cases: results,
          limits: [
            "Provider remains disabled; this is representative acceptance only.",
            "Owned timeout uses a stricter real 250ms query deadline.",
            "No claim of all auth/fetch faults or driver-internal replay prevention.",
            "READ ONLY is not a sandbox against autonomous/side-effecting functions.",
            "Byte acceptance covers aggregate overflow; no >1MiB single scalar/row fixture is claimed.",
          ],
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  }
}

async function terminateChildren() {
  await Promise.all(
    [...CHILDREN].map(
      (child) =>
        new Promise((resolve) => {
          child.once("close", resolve);
          child.kill("SIGKILL");
        }),
    ),
  );
}

// Deliberately no default skip: manually starting this file outside authorized
// CI must fail before driver import, child allocation or network activity.
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.ORACLE_TCPS_ACCEPTANCE !== "1"
) {
  console.error("ORACLE_TCPS_CI_AUTHORIZATION_GATE_REQUIRED");
  process.exitCode = 1;
} else if (process.argv[2] === "--tls-diagnostic") {
  diagnosticChild();
} else {
  try {
    await main();
  } catch {
    console.error("ORACLE_TCPS_REPRESENTATIVE_ACCEPTANCE_FAILED");
    process.exitCode = 1;
  } finally {
    await terminateChildren();
  }
}
