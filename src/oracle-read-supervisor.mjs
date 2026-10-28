// Disabled WIP: no HTTP/session/CLI/MCP/script registry imports this module.
// A separate Node process also isolates startup-time TLS/env configuration.
import { fork } from "node:child_process";
import { serialize } from "node:v8";
import { oracleReadInput } from "./oracle-read-config.mjs";
import { oracleReadFailure } from "./oracle-read-wip.mjs";

function validResult(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.columns) ||
    value.columns.length > 128 ||
    value.columns.some((x) => typeof x !== "string") ||
    new Set(value.columns).size !== value.columns.length ||
    !Array.isArray(value.rows) ||
    value.rows.length > 1000 ||
    value.limit !== 1000 ||
    typeof value.truncated !== "boolean"
  )
    return false;
  if (
    Object.keys(value).some(
      (x) => !["columns", "rows", "truncated", "limit"].includes(x),
    )
  )
    return false;
  for (const row of value.rows) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).length !== value.columns.length
    )
      return false;
    for (const column of value.columns) {
      if (!Object.hasOwn(row, column)) return false;
      const cell = row[column];
      if (cell === null || typeof cell === "string") continue;
      if (
        !cell ||
        typeof cell !== "object" ||
        Array.isArray(cell) ||
        Object.keys(cell).length !== 2 ||
        cell.type !== "blob" ||
        typeof cell.base64 !== "string"
      )
        return false;
    }
  }
  return Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024;
}
const spawnWorker = (url, options) => fork(url, [], options);

// Injection is a test seam, not request-controlled configuration. A child must
// emit close on real process/IPC closure; kill() returning true is not evidence.
export async function runOracleReadOwned(
  input,
  {
    signal,
    createWorker = spawnWorker,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  if (signal?.aborted) throw oracleReadFailure("ORACLE_WIP_CANCELLED");
  const normalized = oracleReadInput(input);
  // Electron-as-Node startup needs separate validation; never start its GUI.
  if (process.versions.electron && createWorker === spawnWorker)
    throw oracleReadFailure("ORACLE_WIP_DRIVER_UNAVAILABLE");
  // Only canonical validated fields cross IPC, not extra array properties.
  const data = {
    host: input.host,
    port: input.port,
    service: input.service,
    user: input.user,
    password: input.password,
    ssl: true,
    sql: normalized.sql,
    parameters: normalized.binds,
  };
  if (serialize(data).byteLength > 2 * 1024 * 1024)
    throw oracleReadFailure("ORACLE_WIP_QUERY_FAILED");
  return new Promise((resolve, reject) => {
    let worker,
      failure,
      payload,
      phaseTimer,
      totalTimer,
      closed = false;
    let phaseIndex = 0,
      connectedPhaseSeen = false,
      terminalMessage = false,
      queryObserved = false;
    const phases = ["connect", "setup", "classify", "query", "cleanup"];
    const fail = (code) => {
      if (closed || failure) return;
      failure = oracleReadFailure(code);
      // No replay, remote admin command, break-only cancellation, or driver
      // private socket access. Only this invocation's process is terminated.
      try {
        worker?.kill("SIGKILL");
      } catch {}
    };
    const armPhase = (milliseconds) => {
      clearTimer(phaseTimer);
      phaseTimer = setTimer(() => fail("ORACLE_WIP_TIMEOUT"), milliseconds);
    };
    const cancel = () => fail("ORACLE_WIP_CANCELLED");
    totalTimer = setTimer(() => fail("ORACLE_WIP_TIMEOUT"), 8000);
    armPhase(3000); // Includes process startup, driver loading, and auth.
    try {
      worker = createWorker(
        new URL("./oracle-read-worker.mjs", import.meta.url),
        {
          execPath: process.execPath,
          env: {},
          execArgv: [],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          serialization: "advanced",
          windowsHide: true,
        },
      );
    } catch {
      clearTimer(phaseTimer);
      clearTimer(totalTimer);
      reject(oracleReadFailure("ORACLE_WIP_WORKER_FAILED"));
      return;
    }
    worker.on("message", (message) => {
      if (closed || failure) return;
      if (terminalMessage) {
        fail("ORACLE_WIP_WORKER_FAILED");
        return;
      }
      if (message?.kind === "oracle-phase") {
        const next = phases.indexOf(message.phase);
        if (next === 0 && phaseIndex === 0 && !connectedPhaseSeen) {
          connectedPhaseSeen = true;
          return; // Do not extend startup/auth's original three-second budget.
        }
        if (
          next < 1 ||
          (next !== phaseIndex + 1 && next !== 4) ||
          phaseIndex === 4
        ) {
          fail("ORACLE_WIP_WORKER_FAILED");
          return;
        }
        phaseIndex = next;
        if (next === 3) queryObserved = true;
        armPhase(2000); // Setup, classification, all fetches, then cleanup.
        return;
      }
      if (phaseIndex !== 4) {
        fail("ORACLE_WIP_WORKER_FAILED");
        return;
      }
      if (message?.kind === "oracle-result") {
        let valid = false;
        try {
          valid = queryObserved && validResult(message.result);
        } catch {}
        if (!valid) {
          fail("ORACLE_WIP_WORKER_FAILED");
          return;
        }
        payload = message.result;
      } else if (message?.kind === "oracle-error") {
        if (
          ![
            "ORACLE_WIP_QUERY_FAILED",
            "ORACLE_WIP_CLEANUP_FAILED",
            "ORACLE_WIP_DRIVER_UNAVAILABLE",
            "ORACLE_WIP_CANCELLED",
          ].includes(message.code)
        ) {
          fail("ORACLE_WIP_WORKER_FAILED");
          return;
        }
        payload = oracleReadFailure(message.code);
      } else {
        fail("ORACLE_WIP_WORKER_FAILED");
        return;
      }
      terminalMessage = true;
      // Keep both deadlines live until actual process/IPC close, not a result.
    });
    worker.on("error", () => fail("ORACLE_WIP_WORKER_FAILED"));
    worker.once("close", (code, exitSignal) => {
      closed = true;
      clearTimer(phaseTimer);
      clearTimer(totalTimer);
      signal?.removeEventListener("abort", cancel);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0 || exitSignal || !terminalMessage) {
        reject(oracleReadFailure("ORACLE_WIP_WORKER_FAILED"));
        return;
      }
      if (payload instanceof Error) reject(payload);
      else resolve(payload);
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      if (!failure)
        worker.send(data, (error) => {
          if (error) fail("ORACLE_WIP_WORKER_FAILED");
        });
    } catch {
      fail("ORACLE_WIP_WORKER_FAILED");
    }
  });
}
