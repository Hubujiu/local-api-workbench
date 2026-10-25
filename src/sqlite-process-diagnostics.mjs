// Codes only: never retain messages, stacks, SQL, parameters or database paths.
const codes = new Set([
  "EACCES",
  "ENOENT",
  "ENOMEM",
  "EPIPE",
  "EPERM",
  "EAGAIN",
  "ERR_IPC_CHANNEL_CLOSED",
  "ERR_IPC_DISCONNECTED",
  "ERR_INVALID_ARG_TYPE",
  "ERR_WORKER_OUT_OF_MEMORY",
  "ERR_WORKER_UNSERIALIZABLE_ERROR",
]);
export function sqliteProcessErrorCode(error) {
  return error ? (codes.has(error.code) ? error.code : "OTHER") : null;
}
export const sqliteProcessStages = new Set([
  "supervisor-ready",
  "worker-online",
  "worker-ready",
  "worker-result",
  "worker-exit",
  "worker-error",
]);
export function sqliteExitCode(code) {
  return Number.isSafeInteger(code) && Math.abs(code) <= 4294967295
    ? code
    : null;
}

const failureCodes = new Set([
  "SQLITE_WRITE_OUTCOME_UNKNOWN",
  "SQLITE_QUERY_TIMEOUT",
  "SQLITE_QUERY_PROCESS_FAILED",
]);
const signals = new Set([
  "SIGKILL",
  "SIGTERM",
  "SIGABRT",
  "SIGSEGV",
  "SIGILL",
  "SIGBUS",
  "SIGFPE",
  "SIGINT",
  "SIGQUIT",
  "SIGHUP",
]);
const phases = new Set([
  "fork-pending",
  "process-spawned",
  "result-received",
  ...sqliteProcessStages,
]);
const milliseconds = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 86400000 ? value : null;
// Public HTTP/CI boundary: reconstruct a fixed allowlist, never spread an Error
// or arbitrary diagnostic object into API responses or desktop failure logs.
export function sqliteProcessFailureDetails(error) {
  if (
    !failureCodes.has(error?.code) ||
    !error?.diagnostics ||
    typeof error.diagnostics !== "object"
  )
    return {};
  const d = error.diagnostics;
  return {
    code: error.code,
    diagnostics: {
      phase: phases.has(d.phase) ? d.phase : "unknown",
      elapsedMs: milliseconds(d.elapsedMs),
      timeout: d.timeout === true,
      exitCode: sqliteExitCode(d.exitCode),
      signal: signals.has(d.signal) ? d.signal : null,
      receivedResult: d.receivedResult === true,
      ...Object.fromEntries(
        [
          "spawnErrorCode",
          "processErrorCode",
          "sendErrorCode",
          "workerErrorCode",
        ].map((key) => [
          key,
          d[key] == null ? null : sqliteProcessErrorCode({ code: d[key] }),
        ]),
      ),
      workerExitCode: sqliteExitCode(d.workerExitCode),
      supervisorReadyMs: milliseconds(d.supervisorReadyMs),
      workerReadyMs: milliseconds(d.workerReadyMs),
      resultReceivedMs: milliseconds(d.resultReceivedMs),
    },
  };
}
