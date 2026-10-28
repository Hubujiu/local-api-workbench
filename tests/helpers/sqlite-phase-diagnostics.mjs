import { types } from "node:util";
import { sqliteProcessFailureDetails } from "../../src/sqlite-process-diagnostics.mjs";

export const sqliteTestPhases = Object.freeze({
  expectedTimeoutChild: "expected-timeout-child",
  recoveryOpenRead: "recovery-open/read",
  postRecoveryRead: "post-recovery-read",
  independentWrite: "independent-write",
  finalRead: "final-read",
});
const phases = new Set(Object.values(sqliteTestPhases));
const diagnosticKeys = [
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
];

function ownValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function failureDetails(error) {
  const source = ownValue(error, "diagnostics");
  if (!source || typeof source !== "object" || types.isProxy(source)) return {};
  // The production whitelist may read properties: pass only inert own data,
  // never the original Error, accessors, proxies or nested arbitrary values.
  const snapshot = Object.create(null);
  const code = ownValue(error, "code");
  snapshot.code = typeof code === "string" ? code : undefined;
  snapshot.diagnostics = Object.create(null);
  for (const key of diagnosticKeys) {
    const value = ownValue(source, key);
    if (
      value === null ||
      ["string", "number", "boolean"].includes(typeof value)
    )
      snapshot.diagnostics[key] = value;
  }
  return sqliteProcessFailureDetails(snapshot);
}

function appendPhase(error, phase) {
  try {
    if (
      !phases.has(phase) ||
      types.isProxy(error) ||
      !types.isNativeError(error)
    )
      return;
    const message = Object.getOwnPropertyDescriptor(error, "message");
    if (
      !message ||
      !Object.hasOwn(message, "value") ||
      typeof message.value !== "string" ||
      message.writable !== true
    )
      return;
    const metadata = Object.create(null);
    metadata.phase = phase;
    const details = failureDetails(error);
    if (Object.hasOwn(details, "code")) {
      metadata.code = details.code;
      metadata.diagnostics = Object.create(null);
      for (const key of diagnosticKeys)
        metadata.diagnostics[key] = details.diagnostics[key];
    }
    const suffix = `\nSQLITE_PHASE_METADATA ${JSON.stringify(metadata)}`;
    if (Buffer.byteLength(suffix, "utf8") > 2048) return;
    // Retain the original message (which is NOT claimed to be redacted).
    // Leave stack/cause/code/assertion fields untouched; never read stack's
    // lazy accessor just to annotate a failure. Unsupported errors pass through.
    Object.defineProperty(error, "message", {
      value: message.value + suffix,
    });
  } catch {
    // Diagnostics must never replace the original thrown value or failure.
  }
}

export async function withSQLitePhase(phase, operation) {
  try {
    return await operation();
  } catch (error) {
    appendPhase(error, phase);
    throw error;
  }
}
