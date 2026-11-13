import { AssertionError } from "node:assert";
import { isProxy } from "node:util/types";
import { workerFailureMetadata } from "./worker-rejection-diagnostics.mjs";

const maxInputBytes = 2 * 1024 * 1024;
const statuses = new Set(["passed", "failed", "cancelled", "skipped"]);
const phases = [
  "compatibility",
  "functionLibrary",
  "userScript",
  "microtask",
  "callback",
  "promiseState",
  "serialization",
];
const object = () => Object.create(null);
const own = (value, key) =>
  value && typeof value === "object" && Object.hasOwn(value, key)
    ? value[key]
    : undefined;

// Exact persisted error strings only; this is an observation, not a root-cause
// claim: user scripts can throw the same text. Never use this label for security
// or result decisions, coerce values, inspect objects or infer from phase timings.
export function cliReportedErrorKind(error) {
  if (error === "脚本执行超时") return "script-timeout";
  if (error === "interrupted") return "interrupted";
  return "other";
}

// Input is JSON text, never a runtime object. Reuse the worker whitelist after
// translating persisted flattened diagnostics back to its numeric field names.
function stepMetadata(step, index) {
  const result = object();
  result.stepIndex = index;
  const status = own(step, "status");
  result.status = statuses.has(status) ? status : "unknown";
  result.reportedErrorKind = cliReportedErrorKind(own(step, "error"));
  const source = own(step, "scriptDiagnostics");
  const raw = object();
  raw.scriptStage = own(step, "scriptStage");
  raw.scriptDiagnostics = source;
  raw.hostLifecycle = own(source, "hostLifecycle");
  raw.hostSequence = own(source, "hostSequence");
  raw.lastWorkerStage = own(source, "lastWorkerStage");
  raw.activityOperation = own(source, "activityOperation");
  raw.elapsedMs = own(source, "elapsedMs");
  raw.activityMetrics = source;
  raw.activityCPUTimeUs = object();
  const compatibility = object();
  compatibility.version = 1;
  compatibility.operation = own(source, "compatibilityOperation");
  for (const prefix of [
    "MockAsset",
    "MockInstall",
    "SourceBuild",
    "Evaluation",
  ]) {
    const field = prefix[0].toLowerCase() + prefix.slice(1);
    compatibility[field + "Ms"] = own(source, "compat" + prefix + "Ms");
    compatibility[field + "CPUUs"] = own(source, "compat" + prefix + "CPUUs");
  }
  raw.compatibilityDiagnostics = compatibility;
  for (const phase of phases)
    raw.activityCPUTimeUs[`${phase}Us`] = own(source, `${phase}CPUUs`);
  Object.assign(result, workerFailureMetadata(raw));
  return result;
}

export function cliResultMetadata(stdout) {
  const result = object();
  if (typeof stdout !== "string") {
    result.input = "not-text";
    return result;
  }
  // Reject oversized text before parsing; do not parse a truncated prefix.
  if (
    stdout.length > maxInputBytes ||
    Buffer.byteLength(stdout) > maxInputBytes
  ) {
    result.input = "oversized";
    return result;
  }
  let run;
  try {
    run = JSON.parse(stdout);
  } catch {
    result.input = "invalid-json";
    return result;
  }
  const steps = own(run, "results");
  if (!run || Array.isArray(run) || !Array.isArray(steps)) {
    result.input = "invalid-shape";
    return result;
  }
  result.input = "json";
  if (statuses.has(own(run, "status"))) result.status = run.status;
  result.resultCount = steps.length;
  result.scannedCount = Math.min(steps.length, 200);
  result.unscannedCount = steps.length - result.scannedCount;
  result.omittedCount = 0;
  result.steps = object();
  let retained = 0;
  for (let i = 0; i < result.scannedCount; i++) {
    if (own(steps[i], "status") === "passed") continue;
    if (retained === 4) {
      result.omittedCount++;
      continue;
    }
    result.steps[retained++] = stepMetadata(steps[i], i);
  }
  return result;
}

function fitMetadata(result) {
  const tooLarge = () =>
    Buffer.byteLength("\nCLI_RESULT_METADATA " + JSON.stringify(result)) > 4096;
  const retained = Object.keys(result.steps || {}).length;
  let hostOmitted = 0,
    compatibilityOmitted = 0;
  for (let index = retained - 1; index >= 0 && tooLarge(); index--) {
    const step = result.steps[index];
    if (
      Object.hasOwn(step, "hostLifecycle") ||
      Object.hasOwn(step, "hostSequence")
    ) {
      delete step.hostLifecycle;
      delete step.hostSequence;
      result.hostObservationsOmitted = ++hostOmitted;
    }
  }
  for (let index = retained - 1; index >= 0 && tooLarge(); index--) {
    const step = result.steps[index];
    if (Object.hasOwn(step, "compatibilityDiagnostics")) {
      delete step.compatibilityDiagnostics;
      result.compatibilityObservationsOmitted = ++compatibilityOmitted;
    }
  }
  for (let index = retained - 1; index >= 0 && tooLarge(); index--) {
    delete result.steps[index];
    result.omittedCount++;
  }
}

// Optional test-side facts already observed by a fixture. These are not worker
// request counters or a claimed before/after phase; no URLs or values are copied.
// Response presence means an own record property, not success or phase completion.
// Out-of-range counts are omitted, not clamped or used to change test admission.
export function workflowFailureObservations(source) {
  const result = object();
  if (!source || typeof source !== "object" || isProxy(source)) return result;
  for (const key of [
    "loginRequestCount",
    "laterRequestCount",
    "hasRecordedResponse",
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
    const value = descriptor.value;
    if (
      key === "hasRecordedResponse"
        ? typeof value === "boolean"
        : Number.isSafeInteger(value) && value >= 0 && value <= 16
    )
      result[key] = value;
  }
  return result;
}

// Synchronous by design: retain the caller's exact assertion, one invocation,
// expected/actual values and AssertionError identity. Parse only on failure.
export function withCLIResultDiagnostics(
  assertion,
  stdout,
  observations,
  diagnostic,
) {
  try {
    return assertion();
  } catch (error) {
    if (error && !isProxy(error) && error instanceof AssertionError) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor?.writable && typeof descriptor.value === "string") {
        const metadata = cliResultMetadata(stdout);
        const workflow = workflowFailureObservations(observations);
        if (Object.keys(workflow).length)
          metadata.workflowObservations = workflow;
        fitMetadata(metadata);
        let suffix = "\nCLI_RESULT_METADATA " + JSON.stringify(metadata);
        if (Buffer.byteLength(suffix) > 4096)
          suffix = '\nCLI_RESULT_METADATA {"input":"metadata-too-large"}';
        error.message = descriptor.value + suffix;
        // Node reporters may print a previously cached AssertionError.stack.
        // Emit only the bounded whitelist, never the original assertion or data.
        if (typeof diagnostic === "function") {
          try {
            diagnostic(suffix.trimStart());
          } catch {
            // Observability must never replace the original failure.
          }
        }
      }
    }
    throw error;
  }
}
