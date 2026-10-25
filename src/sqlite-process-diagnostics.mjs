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
