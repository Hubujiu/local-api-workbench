import { AssertionError } from "node:assert";
import { isProxy } from "node:util/types";

// Test-only snapshot of src/script-diagnostics.mjs and raw script-worker fields.
// Native completion labels also occur in the reviewed integration worker. Keep
// this explicit: never serialize an Error or copy an arbitrary diagnostic object.
const stages = new Set([
  "starting",
  "loading-libraries",
  "loading-engine",
  "bootstrap",
  "compatibility",
  "script",
  "async-completion",
  "serialization",
  "total-deadline",
  "cancelled",
  "response-override",
  "sequence-budget",
  "sequence-output",
]);
const operations = new Set([
  "bootstrap",
  "compatibility",
  "function-library",
  "user-script",
  "microtasks",
  "promise-state",
  "pending-tasks",
  "http-callback",
  "timer-callback",
  "serialization",
  "pick-vars-completion",
  "native-assertion-completion",
  "native-assertion-evidence",
  "native-wait-completion",
]);
const counters = {
  activityBudgetMs: 250,
  fakerCalls: 1001,
  timerCount: 101,
  requestCount: 11,
};
const milliseconds = [
  "compatibilityMs",
  "functionLibraryMs",
  "userScriptMs",
  "microtaskMs",
  "callbackMs",
  "promiseStateMs",
  "serializationMs",
  "fakerLoadMs",
];
const microseconds = [
  "compatibilityUs",
  "functionLibraryUs",
  "userScriptUs",
  "microtaskUs",
  "callbackUs",
  "promiseStateUs",
  "serializationUs",
];
const prefix = "\nWORKER_REJECTION_METADATA ";
const maxSuffixBytes = 2048;

function ownData(object, key) {
  if (!object || typeof object !== "object" || isProxy(object)) return;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function copyNumber(target, source, key, max) {
  const value = ownData(source, key);
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max &&
    (key === "activityBudgetMs" || Number.isInteger(value))
  )
    target[key] = value;
}

export function workerFailureMetadata(error) {
  // Null prototypes prevent inherited toJSON hooks during serialization.
  const result = Object.create(null);
  for (const key of ["scriptStage", "lastWorkerStage"]) {
    const value = ownData(error, key);
    if (stages.has(value)) result[key] = value;
  }
  const operation = ownData(error, "activityOperation");
  if (operations.has(operation)) result.activityOperation = operation;
  copyNumber(result, error, "elapsedMs", 60000);
  for (const [key, limits] of [
    ["scriptDiagnostics", Object.entries(counters)],
    ["activityMetrics", milliseconds.map((name) => [name, 60000])],
    ["activityCPUTimeUs", microseconds.map((name) => [name, 60000000])],
  ]) {
    const source = ownData(error, key);
    const values = Object.create(null);
    for (const [name, max] of limits) copyNumber(values, source, name, max);
    if (Object.keys(values).length) result[key] = values;
  }
  return result;
}

// The caller retains its original assert.rejects call/regex and phase input.
// Observe one rejection without changing it; only an assertion failure receives
// metadata. Successful assertions do not even inspect the worker's fields.
export async function withWorkerRejectionDiagnostics(assertion) {
  let rejection;
  const captureRejection = (error) => {
    rejection = error;
    throw error;
  };
  try {
    await assertion(captureRejection);
  } catch (failure) {
    if (!isProxy(failure) && failure instanceof AssertionError) {
      const message = Object.getOwnPropertyDescriptor(failure, "message");
      if (message && typeof message.value === "string" && message.writable) {
        const suffix =
          prefix + JSON.stringify(workerFailureMetadata(rejection));
        if (Buffer.byteLength(suffix, "utf8") <= maxSuffixBytes)
          Object.defineProperty(failure, "message", {
            ...message,
            value: message.value + suffix,
          });
      }
    }
    throw failure;
  }
}
