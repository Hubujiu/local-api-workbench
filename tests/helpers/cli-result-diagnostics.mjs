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

// Input is JSON text, never a runtime object. Reuse the worker whitelist after
// translating persisted flattened diagnostics back to its numeric field names.
function stepMetadata(step, index) {
  const result = object();
  result.stepIndex = index;
  const status = own(step, "status");
  result.status = statuses.has(status) ? status : "unknown";
  const source = own(step, "scriptDiagnostics");
  const raw = object();
  raw.scriptStage = own(step, "scriptStage");
  raw.scriptDiagnostics = source;
  raw.lastWorkerStage = own(source, "lastWorkerStage");
  raw.activityOperation = own(source, "activityOperation");
  raw.elapsedMs = own(source, "elapsedMs");
  raw.activityMetrics = source;
  raw.activityCPUTimeUs = object();
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

// Synchronous by design: retain the caller's exact assertion, one invocation,
// expected/actual values and AssertionError identity. Parse only on failure.
export function withCLIResultDiagnostics(assertion, stdout) {
  try {
    return assertion();
  } catch (error) {
    if (error && !isProxy(error) && error instanceof AssertionError) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor?.writable && typeof descriptor.value === "string") {
        const metadata = cliResultMetadata(stdout);
        let suffix = "\nCLI_RESULT_METADATA " + JSON.stringify(metadata);
        if (Buffer.byteLength(suffix) > 4096)
          suffix = '\nCLI_RESULT_METADATA {"input":"metadata-too-large"}';
        error.message = descriptor.value + suffix;
      }
    }
    throw error;
  }
}
