import { isProxy } from "node:util/types";

// CI-only snapshot of worker observation fields. Never import application code.
export const WORKER_PREFIX = "CORE_WORKER_OBSERVATION_V1 ";
export const MAX_PACKET_BYTES = 2048;
export const MAX_OBSERVER_PACKETS = 64;
export const MAX_OBSERVER_BYTES = MAX_PACKET_BYTES * MAX_OBSERVER_PACKETS;
export const MAX_ERROR_DEPTH = 4;
export const MAX_ERROR_NODES = 15;
export const MAX_WORKER_OBSERVATIONS = 4;

const create = Object.create;
const descriptor = Object.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;
const hasOwn = Object.hasOwn;
const setPrototypeOf = Object.setPrototypeOf;
const stringify = JSON.stringify;
const parse = JSON.parse;
const byteLength = Buffer.byteLength;
const finite = Number.isFinite;
const integer = Number.isInteger;
const isArray = Array.isArray;
const apply = Reflect.apply;
const slice = String.prototype.slice;
const charCodeAt = String.prototype.charCodeAt;
const weakHas = WeakSet.prototype.has;
const weakAdd = WeakSet.prototype.add;
const WeakSetConstructor = WeakSet;

function enumeration(values) {
  const result = create(null);
  for (let i = 0; i < values.length; i++) result[values[i]] = true;
  return result;
}
const stages = enumeration([
  "starting", "loading-libraries", "loading-engine", "bootstrap",
  "compatibility", "script", "async-completion", "serialization",
  "total-deadline", "cancelled", "response-override", "sequence-budget",
  "sequence-output",
]);
const operations = enumeration([
  "bootstrap", "compatibility", "function-library", "user-script",
  "microtasks", "promise-state", "pending-tasks", "http-callback",
  "timer-callback", "serialization", "pick-vars-completion",
  "native-assertion-completion", "native-assertion-evidence",
  "native-wait-completion",
]);
const bootstrapOperations = enumeration([
  "context-and-bindings", "input-transfer", "setup", "url-tools",
  "trusted-libraries", "optional-facade", "lazy-installers",
]);
const direct = [
  ["scriptStage", stages], ["lastWorkerStage", stages],
  ["activityOperation", operations], ["elapsedMs", 60000],
];
const counters = [
  ["activityBudgetMs", 250, true], ["fakerCalls", 1001],
  ["timerCount", 101], ["requestCount", 11],
];
const bootstrap = [
  ["bootstrapOperation", bootstrapOperations],
  ["bootstrapElapsedMs", 60000], ["bootstrapOperationMs", 60000],
  ["bootstrapCPUUs", 60000000], ["bootstrapOperationCPUUs", 60000000],
];
const milliseconds = [
  ["compatibilityMs", 60000], ["functionLibraryMs", 60000],
  ["userScriptMs", 60000], ["microtaskMs", 60000], ["callbackMs", 60000],
  ["promiseStateMs", 60000], ["serializationMs", 60000], ["fakerLoadMs", 60000],
];
const microseconds = [
  ["compatibilityUs", 60000000], ["functionLibraryUs", 60000000],
  ["userScriptUs", 60000000], ["microtaskUs", 60000000],
  ["callbackUs", 60000000], ["promiseStateUs", 60000000],
  ["serializationUs", 60000000],
];
const nestedFields = [
  ["scriptDiagnostics", counters], ["activityMetrics", milliseconds],
  ["activityCPUTimeUs", microseconds],
];
// Trusted schema tuples must not read inherited optional indices or iterators.
for (const schema of [direct, counters, bootstrap, milliseconds, microseconds, nestedFields]) {
  for (let i = 0; i < schema.length; i++) setPrototypeOf(schema[i], null);
  setPrototypeOf(schema, null);
}

function record(value) {
  return value !== null && typeof value === "object" && !isProxy(value);
}
function own(value, key) {
  if (!record(value)) return undefined;
  const property = descriptor(value, key);
  return property && hasOwn(property, "value") ? property.value : undefined;
}
function count(value) { return ownKeys(value).length; }
function valid(value, rule, fractional) {
  return typeof rule === "number"
    ? typeof value === "number" && finite(value) && value >= 0 && value <= rule &&
        (fractional || integer(value))
    : typeof value === "string" && hasOwn(rule, value);
}
function copyFields(target, source, schema) {
  for (let i = 0; i < schema.length; i++) {
    const tuple = schema[i], key = tuple[0], rule = tuple[1], fractional = tuple[2];
    const value = own(source, key);
    if (valid(value, rule, fractional)) target[key] = value;
  }
}
function metadata(source, strict = false) {
  if (!record(source)) return undefined;
  const result = create(null);
  copyFields(result, source, direct);
  for (let i = 0; i < nestedFields.length; i++) {
    const tuple = nestedFields[i], key = tuple[0], schema = tuple[1];
    const raw = own(source, key);
    if (raw === undefined) continue;
    const projected = create(null);
    copyFields(projected, raw, schema);
    if (key === "scriptDiagnostics" && result.scriptStage === "bootstrap" &&
        valid(own(raw, "bootstrapOperation"), bootstrapOperations)) {
      copyFields(projected, raw, bootstrap);
    }
    if (strict && (!record(raw) || count(raw) !== count(projected) || !count(projected))) return undefined;
    if (count(projected)) result[key] = projected;
  }
  if (!count(result)) return undefined;
  if (strict && count(source) !== count(result) + 1) return undefined; // depth
  return result;
}

export function observationName(value) {
  if (typeof value !== "string") return undefined;
  const first = apply(charCodeAt, value, [0]);
  if (first === 47 || first === 92 ||
      ((first >= 65 && first <= 90 || first >= 97 && first <= 122) && apply(charCodeAt, value, [1]) === 58)) return undefined;
  let result = "";
  for (let i = 0; i < value.length && i < 256; i++) {
    const code = apply(charCodeAt, value, [i]);
    result += code <= 31 || code === 127 ? " " : apply(slice, value, [i, i + 1]);
  }
  return result;
}

export function projectWorkerFailure(error, name) {
  const packet = create(null);
  packet.version = 1;
  const safeName = observationName(name);
  if (safeName !== undefined) packet.name = safeName;
  const workers = setPrototypeOf([], null);
  const queue = setPrototypeOf([{ value: error, depth: 0 }], null);
  const visited = new WeakSetConstructor();
  let head = 0, tail = 1, examined = 0, bounded = false;
  while (head < tail && examined < MAX_ERROR_NODES && workers.length < MAX_WORKER_OBSERVATIONS) {
    const { value, depth } = queue[head++];
    examined++;
    if (!record(value) || apply(weakHas, visited, [value])) continue;
    apply(weakAdd, visited, [value]);
    const safe = metadata(value);
    if (safe) {
      safe.depth = depth;
      workers[workers.length] = safe;
    }
    for (let i = 0; i < 2; i++) {
      const linked = own(value, i === 0 ? "actual" : "cause");
      if (!record(linked) || apply(weakHas, visited, [linked])) continue;
      if (depth < MAX_ERROR_DEPTH) queue[tail++] = { value: linked, depth: depth + 1 };
      else bounded = true;
    }
  }
  packet.availability = workers.length ? "observed" : "unavailable";
  packet.traversal = bounded || head < tail ? "bounded" : "complete";
  if (workers.length) packet.workers = workers;
  return packet;
}

// A second strict projection after JSON.parse: never forward diagnostic text.
export function parseWorkerDiagnostic(message) {
  if (typeof message !== "string" || message.length > MAX_PACKET_BYTES ||
      byteLength(message) > MAX_PACKET_BYTES ||
      apply(slice, message, [0, WORKER_PREFIX.length]) !== WORKER_PREFIX) return undefined;
  let raw;
  try { raw = parse(apply(slice, message, [WORKER_PREFIX.length])); } catch { return undefined; }
  if (!record(raw) || own(raw, "version") !== 1) return undefined;
  const result = create(null);
  result.version = 1;
  const availability = own(raw, "availability");
  if (availability === "capped") {
    if (count(raw) !== 2) return undefined;
    result.availability = "capped";
    return result;
  }
  if (availability !== "observed" && availability !== "unavailable") return undefined;
  const name = own(raw, "name");
  if (name !== undefined) {
    if (typeof name !== "string" || observationName(name) !== name) return undefined;
    result.name = name;
  }
  result.availability = availability;
  const traversal = own(raw, "traversal");
  if (traversal !== "complete" && traversal !== "bounded") return undefined;
  result.traversal = traversal;
  const workers = own(raw, "workers");
  if (availability === "observed") {
    if (!isArray(workers) || workers.length < 1 || workers.length > MAX_WORKER_OBSERVATIONS) return undefined;
    const projected = setPrototypeOf([], null);
    for (let i = 0; i < workers.length; i++) {
      const worker = workers[i], depth = own(worker, "depth");
      if (!valid(depth, MAX_ERROR_DEPTH)) return undefined;
      const safe = metadata(worker, true);
      if (!safe) return undefined;
      safe.depth = depth;
      projected[i] = safe;
    }
    result.workers = projected;
  } else if (workers !== undefined) return undefined;
  if (count(raw) !== count(result)) return undefined;
  return result;
}

const capPacket = create(null);
capPacket.version = 1;
capPacket.availability = "capped";
const capLine = WORKER_PREFIX + stringify(capPacket);

// One instance per test-file process. Emission failures never change its tests.
export function createWorkerObserver() {
  let packets = 0, bytes = 0, capped = false;
  return (error, name, emit) => {
    if (capped || !error) return;
    try {
      const projected = projectWorkerFailure(error, name);
      let line = WORKER_PREFIX + stringify(projected);
      let size = byteLength(line);
      while (size > MAX_PACKET_BYTES && projected.workers?.length > 1) {
        projected.workers.length--;
        projected.traversal = "bounded";
        line = WORKER_PREFIX + stringify(projected);
        size = byteLength(line);
      }
      if (size > MAX_PACKET_BYTES) {
        const packet = create(null);
        packet.version = 1;
        packet.availability = "unavailable";
        packet.traversal = "bounded";
        line = WORKER_PREFIX + stringify(packet);
        size = byteLength(line);
      }
      if (packets >= MAX_OBSERVER_PACKETS - 1 || bytes + size > MAX_OBSERVER_BYTES - byteLength(capLine)) {
        capped = true;
        emit(capLine);
        return;
      }
      packets++;
      bytes += size;
      emit(line);
    } catch { /* Observation must not replace a passing or failing test result. */ }
  };
}
