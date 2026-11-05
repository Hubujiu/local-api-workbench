// Fixed, bounded diagnostic schema. Never serialize an arbitrary error/receipt.
export function formatFixtureReceipt(value) {
  const input = value && typeof value === "object" ? value : {};
  const phases = new Set(["probe", "build", "execute"]);
  const stages = new Set([
    "admission",
    "job-create",
    "job-configure",
    "job-attributes",
    "atomic-job-admission",
    "resume",
    "execute",
    "job-terminate",
    "job-cleanup-receipt",
  ]);
  const signals = new Set([
    "SIGKILL",
    "SIGTERM",
    "SIGABRT",
    "SIGSEGV",
    "SIGINT",
    "SIGBREAK",
  ]);
  const result = {
    phase: phases.has(input.phase) ? input.phase : null,
    fixture:
      typeof input.fixture === "string" &&
      /^[a-z0-9-]{1,64}$/.test(input.fixture)
        ? input.fixture
        : null,
    signal: signals.has(input.signal) ? input.signal : null,
    wrapperSignal: signals.has(input.wrapperSignal)
      ? input.wrapperSignal
      : null,
    cleanupStage: stages.has(input.cleanupStage) ? input.cleanupStage : null,
  };
  for (const key of [
    "timedOut",
    "aborted",
    "spawnFailed",
    "admissionFailed",
    "childClosed",
    "cleanupConfirmed",
    "wrapperClosed",
    "controlWriteFailed",
    "ownerReceiptValid",
    "terminateJobAccepted",
    "stopObserved",
  ])
    result[key] = typeof input[key] === "boolean" ? input[key] : null;
  for (const key of [
    "exitCode",
    "wrapperExitCode",
    "jobActiveProcesses",
    "finalWaitError",
  ])
    result[key] =
      Number.isInteger(input[key]) &&
      input[key] >= -2147483648 &&
      input[key] <= 0xffffffff
        ? input[key]
        : null;
  result.finalWaitStatus = [0, 258, 0xffffffff].includes(input.finalWaitStatus)
    ? input.finalWaitStatus
    : null;
  result.ownerReceiptBytes =
    Number.isInteger(input.ownerReceiptBytes) &&
    input.ownerReceiptBytes >= 0 &&
    input.ownerReceiptBytes <= 8192
      ? input.ownerReceiptBytes
      : null;
  return JSON.stringify(result);
}
