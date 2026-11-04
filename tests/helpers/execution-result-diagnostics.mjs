import {
  isAsyncFunction as importedIsAsyncFunction,
  isNativeError as importedIsNativeError,
  isPromise as importedIsPromise,
  isProxy as importedIsProxy,
} from "node:util/types";

// Test-only snapshot of public scriptFailureDetails fields, including the
// integration worker's bounded mock/bootstrap counters. No runtime imports.
export const EXECUTION_RESULT_PREFIX = "\nEXECUTION_RESULT_METADATA ";
export const MAX_EXECUTION_RESULT_PACKET_BYTES = 2048;
export const MAX_EXECUTION_RESULT_PACKETS = 32;
export const MAX_EXECUTION_RESULT_BYTES = 16384;
// Named builtin ESM exports remain live after syncBuiltinESMExports(). Capture
// their current values too, before any untrusted result can be observed.
const isAsyncFunction = importedIsAsyncFunction,
  isNativeError = importedIsNativeError,
  isPromise = importedIsPromise,
  isProxy = importedIsProxy,
  create = Object.create,
  descriptor = Object.getOwnPropertyDescriptor,
  define = Object.defineProperty,
  prototype = Object.getPrototypeOf,
  ownKeys = Reflect.ownKeys,
  hasOwn = Object.hasOwn,
  same = Object.is,
  apply = Reflect.apply,
  stringify = JSON.stringify,
  finite = Number.isFinite,
  integer = Number.isInteger,
  isArray = Array.isArray,
  byteLength = Buffer.byteLength,
  includes = String.prototype.includes,
  weakHas = WeakSet.prototype.has,
  weakAdd = WeakSet.prototype.add,
  NativeTypeError = TypeError,
  objectPrototype = Object.prototype;
const missing = Symbol("missing"),
  invalid = Symbol("invalid");
const descriptorFields = [
  "value",
  "get",
  "set",
  "writable",
  "enumerable",
  "configurable",
];
const prototypeKeys = ownKeys(objectPrototype),
  prototypeDescriptors = [];
for (let i = 0; i < prototypeKeys.length; i++)
  prototypeDescriptors[i] = descriptor(objectPrototype, prototypeKeys[i]);

function prototypeUnchanged() {
  if (prototype(objectPrototype) !== null) return false;
  const keys = ownKeys(objectPrototype);
  if (keys.length !== prototypeKeys.length) return false;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== prototypeKeys[i]) return false;
    const current = descriptor(objectPrototype, keys[i]),
      initial = prototypeDescriptors[i];
    for (let j = 0; j < descriptorFields.length; j++) {
      const key = descriptorFields[j],
        a = hasOwn(current, key),
        b = hasOwn(initial, key);
      if (a !== b || (a && !same(current[key], initial[key]))) return false;
    }
  }
  return true;
}

function enumeration(values) {
  const result = create(null);
  for (let i = 0; i < values.length; i++) result[values[i]] = true;
  return result;
}
const stages = enumeration([
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
const operations = enumeration([
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
const bootstrapOperations = enumeration([
  "context-and-bindings",
  "input-transfer",
  "setup",
  "url-tools",
  "trusted-libraries",
  "optional-facade",
  "lazy-installers",
]);
const statuses = enumeration(["passed", "failed", "cancelled", "skipped"]);
const numbers = [
  ["activityBudgetMs", 250, true],
  ["fakerCalls", 1001, false],
  ["mockCalls", 1000, false],
  ["mockNodes", 10000, false],
  ["mockBytes", 1048576, false],
  ["timerCount", 101, false],
  ["requestCount", 11, false],
  ["compatibilityCPUUs", 60000000, false],
  ["functionLibraryCPUUs", 60000000, false],
  ["userScriptCPUUs", 60000000, false],
  ["microtaskCPUUs", 60000000, false],
  ["callbackCPUUs", 60000000, false],
  ["promiseStateCPUUs", 60000000, false],
  ["serializationCPUUs", 60000000, false],
  ["compatibilityMs", 60000, false],
  ["fakerLoadMs", 60000, false],
  ["functionLibraryMs", 60000, false],
  ["userScriptMs", 60000, false],
  ["microtaskMs", 60000, false],
  ["callbackMs", 60000, false],
  ["promiseStateMs", 60000, false],
  ["serializationMs", 60000, false],
  ["elapsedMs", 60000, false],
];
const bootstrapNumbers = [
  ["bootstrapElapsedMs", 60000, false],
  ["bootstrapOperationMs", 60000, false],
  ["bootstrapCPUUs", 60000000, false],
  ["bootstrapOperationCPUUs", 60000000, false],
];
function own(value, key) {
  const property = descriptor(value, key);
  if (!property) return missing;
  if (!hasOwn(property, "value")) throw invalid;
  return property.value;
}
function plainRecord(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    isProxy(value) ||
    isArray(value)
  )
    throw invalid;
  const parent = prototype(value);
  if (
    (parent !== null && parent !== objectPrototype) ||
    descriptor(value, "toJSON")
  )
    throw invalid;
  return value;
}
function enumValue(value, choices) {
  return (
    typeof value === "string" && value.length <= 32 && hasOwn(choices, value)
  );
}
function copyEnum(target, source, key, choices) {
  const value = own(source, key);
  if (enumValue(value, choices)) target[key] = value;
}
function copyNumbers(target, source, schema) {
  for (let i = 0; i < schema.length; i++) {
    const field = schema[i],
      value = own(source, field[0]);
    if (
      typeof value === "number" &&
      finite(value) &&
      value >= 0 &&
      value <= field[1] &&
      (field[2] || integer(value))
    )
      target[field[0]] = value;
  }
}
function unavailable() {
  const result = create(null);
  result.version = 1;
  result.availability = "unavailable";
  result.errorClass = "unavailable";
  return result;
}

// A bounded set of descriptor reads, never a walk, clone or stringify of input.
// Private fields, cycles outside this public shape and huge strings are ignored.
export function executionResultMetadata(input) {
  try {
    if (!prototypeUnchanged()) return unavailable();
    plainRecord(input);
    const result = create(null);
    result.version = 1;
    result.availability = "observed";
    copyEnum(result, input, "status", statuses);
    const error = own(input, "error");
    result.errorClass =
      error === missing
        ? "none"
        : error === "脚本执行超时"
          ? "script-timeout"
          : "other";
    copyEnum(result, input, "scriptStage", stages);
    const raw = own(input, "scriptDiagnostics");
    if (raw !== missing) {
      if (raw === input) throw invalid;
      plainRecord(raw);
      const diagnostics = create(null);
      copyNumbers(diagnostics, raw, numbers);
      copyEnum(diagnostics, raw, "activityOperation", operations);
      copyEnum(diagnostics, raw, "lastWorkerStage", stages);
      if (result.scriptStage === "bootstrap") {
        copyEnum(diagnostics, raw, "bootstrapOperation", bootstrapOperations);
        if (hasOwn(diagnostics, "bootstrapOperation"))
          copyNumbers(diagnostics, raw, bootstrapNumbers);
      }
      if (ownKeys(diagnostics).length) result.scriptDiagnostics = diagnostics;
    }
    return result;
  } catch {
    return unavailable();
  }
}

// Shared across all wrappers in this module's test-file process. Creating an
// additional wrapper never resets the count/byte quota or error deduplication.
const seen = new WeakSet();
let packets = 0,
  bytes = 0;
function annotate(input, failure) {
  try {
    if (
      packets >= MAX_EXECUTION_RESULT_PACKETS ||
      bytes >= MAX_EXECUTION_RESULT_BYTES ||
      isProxy(failure) ||
      !isNativeError(failure) ||
      !prototypeUnchanged() ||
      apply(weakHas, seen, [failure])
    )
      return;
    const message = descriptor(failure, "message");
    if (
      !message ||
      !hasOwn(message, "value") ||
      typeof message.value !== "string" ||
      !message.writable ||
      message.value.length > 4096 ||
      byteLength(message.value) > 4096 ||
      apply(includes, message.value, [EXECUTION_RESULT_PREFIX])
    )
      return;
    const suffix =
      EXECUTION_RESULT_PREFIX + stringify(executionResultMetadata(input));
    const size = byteLength(suffix);
    if (
      size > MAX_EXECUTION_RESULT_PACKET_BYTES ||
      bytes + size > MAX_EXECUTION_RESULT_BYTES
    )
      return;
    const replacement = create(null);
    replacement.value = message.value + suffix;
    replacement.writable = message.writable;
    replacement.enumerable = message.enumerable;
    replacement.configurable = message.configurable;
    define(failure, "message", replacement);
    apply(weakAdd, seen, [failure]);
    packets++;
    bytes += size;
  } catch {
    // Observation can never replace, resolve or reclassify the original failure.
  }
}

function synchronousReturn(value) {
  if (isPromise(value)) return false;
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    return true;
  // Never call .then or a getter. Exotic/deep return values are unsupported.
  for (let depth = 0; value !== null && depth < 8; depth++) {
    if (isProxy(value) || descriptor(value, "then")) return false;
    value = prototype(value);
  }
  return value === null;
}
export function createExecutionResultDiagnostics() {
  return (result, assertion) => {
    if (
      typeof assertion !== "function" ||
      isProxy(assertion) ||
      isAsyncFunction(assertion)
    )
      throw new NativeTypeError("Expected a synchronous assertion callback");
    let returned;
    try {
      returned = assertion();
    } catch (failure) {
      annotate(result, failure);
      throw failure;
    }
    // This is not an async assertion helper. A regular function which starts
    // asynchronous work cannot be undone; callers must not pass such functions.
    if (!synchronousReturn(returned))
      throw new NativeTypeError(
        "Expected a synchronous assertion callback and return value",
      );
    return returned;
  };
}
export const withExecutionResultDiagnostics =
  createExecutionResultDiagnostics();
