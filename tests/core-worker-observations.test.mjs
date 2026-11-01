import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import {
  projectWorkerFailure, parseWorkerDiagnostic, createWorkerObserver,
  WORKER_PREFIX, MAX_PACKET_BYTES, MAX_OBSERVER_PACKETS, MAX_OBSERVER_BYTES,
  MAX_ERROR_DEPTH, MAX_ERROR_NODES, MAX_WORKER_OBSERVATIONS,
} from "../scripts/core-worker-observations.mjs";
import { eligibleObserverEntry } from "../scripts/core-worker-observer-preload.mjs";

function worker() {
  return Object.assign(Error("DO_NOT_COPY_MESSAGE"), {
    scriptStage: "bootstrap", lastWorkerStage: "bootstrap",
    elapsedMs: 123, activityOperation: "bootstrap",
    scriptDiagnostics: {
      activityBudgetMs: 250, fakerCalls: 1, timerCount: 2, requestCount: 3,
      bootstrapOperation: "input-transfer", bootstrapElapsedMs: 12,
      bootstrapOperationMs: 3, bootstrapCPUUs: 4100, bootstrapOperationCPUUs: 900,
      secret: "DO_NOT_COPY_DIAGNOSTIC",
    },
    activityMetrics: { userScriptMs: 7, fakerLoadMs: 1 },
    activityCPUTimeUs: { userScriptUs: 4200 },
    sql: "DO_NOT_COPY_SQL", body: "DO_NOT_COPY_BODY",
    params: ["DO_NOT_COPY_PARAMS"], environment: "DO_NOT_COPY_ENV",
  });
}
function emit(error = worker(), name = "fixture") {
  const lines = [];
  createWorkerObserver()(error, name, (line) => lines.push(line));
  assert.equal(lines.length, 1);
  assert(Buffer.byteLength(lines[0]) <= MAX_PACKET_BYTES);
  assert(!lines[0].includes("DO_NOT_COPY"));
  return parseWorkerDiagnostic(lines[0]);
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function packet(value) { return WORKER_PREFIX + JSON.stringify(value); }

test("worker observation preserves the reviewed bounded stage and wall/CPU fields", () => {
  const value = emit({ cause: { actual: worker() } }, "case\nname");
  assert.deepEqual(plain(value), {
    version: 1, name: "case name", availability: "observed", traversal: "complete",
    workers: [{
      scriptStage: "bootstrap", lastWorkerStage: "bootstrap",
      activityOperation: "bootstrap", elapsedMs: 123,
      scriptDiagnostics: {
        activityBudgetMs: 250, fakerCalls: 1, timerCount: 2, requestCount: 3,
        bootstrapOperation: "input-transfer", bootstrapElapsedMs: 12,
        bootstrapOperationMs: 3, bootstrapCPUUs: 4100, bootstrapOperationCPUUs: 900,
      },
      activityMetrics: { userScriptMs: 7, fakerLoadMs: 1 },
      activityCPUTimeUs: { userScriptUs: 4200 }, depth: 2,
    }],
  });
  const invalid = emit({ scriptStage: "SECRET_STAGE", elapsedMs: Infinity,
    activityMetrics: { userScriptMs: -1 }, scriptDiagnostics: { activityBudgetMs: 251 } });
  assert.equal(invalid.availability, "unavailable");
  assert(!Object.hasOwn(invalid, "workers"));
  assert.equal(emit(worker(), "x".repeat(300)).name.length, 256);
  assert(!Object.hasOwn(emit(worker(), "/DO_NOT_COPY_PATH"), "name"));
  const nonbootstrap = worker();
  nonbootstrap.scriptStage = "script";
  const diagnostics = emit(nonbootstrap).workers[0].scriptDiagnostics;
  assert(!Object.hasOwn(diagnostics, "bootstrapOperation"));
  assert(!Object.hasOwn(diagnostics, "bootstrapElapsedMs"));
});

test("worker observation never invokes proxy traps, Error getters or serialization hooks", () => {
  let reads = 0;
  const error = Object.create({ scriptStage: "script", elapsedMs: 99 });
  for (const key of ["scriptStage", "actual", "cause", "message", "stack", "scriptDiagnostics"]) {
    Object.defineProperty(error, key, { get() { reads++; throw Error("DO_NOT_COPY"); } });
  }
  error.toJSON = () => { reads++; throw Error("DO_NOT_COPY"); };
  assert.equal(emit(error).availability, "unavailable");
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { reads++; throw Error("DO_NOT_COPY"); }, ownKeys() { reads++; throw Error("DO_NOT_COPY"); } });
  assert.equal(emit({ actual: proxy }).availability, "unavailable");
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.equal(emit(revoked.proxy).availability, "unavailable");
  assert.equal(reads, 0);
});

test("worker observation captures stringify and emits only null-prototype output", () => {
  const originalStringify = JSON.stringify;
  let calls = 0;
  const lines = [];
  try {
    Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value() { calls++; throw Error("inherited hook"); } });
    Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value() { calls++; throw Error("array hook"); } });
    JSON.stringify = () => { calls++; throw Error("replaced stringify"); };
    createWorkerObserver()({ cause: { actual: worker() } }, "safe", (line) => lines.push(line));
  } finally {
    JSON.stringify = originalStringify;
    delete Object.prototype.toJSON;
    delete Array.prototype.toJSON;
  }
  assert.equal(calls, 0);
  assert.equal(lines.length, 1);
  const value = parseWorkerDiagnostic(lines[0]);
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(Object.getPrototypeOf(value.workers), null);
  assert.equal(Object.getPrototypeOf(value.workers[0]), null);
  assert.equal(Object.getPrototypeOf(value.workers[0].scriptDiagnostics), null);
});

test("worker observation bounds graph depth, node count, cycles and packets", () => {
  assert.equal(MAX_ERROR_DEPTH, 4);
  assert.equal(MAX_ERROR_NODES, 15);
  assert.equal(MAX_WORKER_OBSERVATIONS, 4);
  const cycle = { scriptStage: "script" }; cycle.cause = cycle;
  assert.equal(emit(cycle).workers.length, 1);
  let deep = worker();
  for (let i = 0; i < 20; i++) deep = { cause: deep };
  assert.equal(emit(deep).availability, "unavailable");
  assert.equal(emit(deep).traversal, "bounded");
  let broad = worker();
  for (let i = 0; i < 6; i++) broad = { actual: broad, cause: worker(), scriptStage: "script" };
  const bounded = emit(broad);
  assert(bounded.workers.length <= MAX_WORKER_OBSERVATIONS);
  assert.equal(bounded.traversal, "bounded");
  const lines = [], observe = createWorkerObserver();
  observe(undefined, "success", (line) => lines.push(line));
  assert.equal(lines.length, 0);
  for (let i = 0; i < MAX_OBSERVER_PACKETS + 30; i++) observe(worker(), "雪".repeat(256), (line) => lines.push(line));
  assert.equal(lines.length, MAX_OBSERVER_PACKETS);
  assert(lines.every((line) => Buffer.byteLength(line) <= MAX_PACKET_BYTES));
  assert(lines.reduce((total, line) => total + Buffer.byteLength(line), 0) <= MAX_OBSERVER_BYTES);
  assert.equal(parseWorkerDiagnostic(lines.at(-1)).availability, "capped");
  assert.equal(lines.filter((line) => parseWorkerDiagnostic(line).availability === "capped").length, 1);
  assert.doesNotThrow(() => createWorkerObserver()(worker(), "safe", () => { throw Error("emit failed"); }));
});

test("worker observation does not use poisoned array iterators, indices or regexp hooks", () => {
  const iterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  const index = Object.getOwnPropertyDescriptor(Array.prototype, "2");
  const testMethod = RegExp.prototype.test, execMethod = RegExp.prototype.exec;
  const arrayCheck = Array.isArray;
  const error = worker();
  let calls = 0, line, projected;
  const forbidden = () => { calls++; throw Error("prototype hook"); };
  try {
    Object.defineProperty(Array.prototype, Symbol.iterator, { configurable: true, value: forbidden });
    Object.defineProperty(Array.prototype, "2", { configurable: true, get: forbidden, set: forbidden });
    RegExp.prototype.test = forbidden;
    RegExp.prototype.exec = forbidden;
    Array.isArray = forbidden;
    createWorkerObserver()(error, "safe\nname", (value) => { line = value; });
    projected = parseWorkerDiagnostic(line);
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, iterator);
    if (index) Object.defineProperty(Array.prototype, "2", index);
    else delete Array.prototype[2];
    RegExp.prototype.test = testMethod;
    RegExp.prototype.exec = execMethod;
    Array.isArray = arrayCheck;
  }
  assert.equal(calls, 0);
  assert.equal(projected?.name, "safe name");
  assert.equal(projected?.workers[0].scriptDiagnostics.bootstrapCPUUs, 4100);
});

test("worker diagnostic parser rejects unknown, forged and out-of-range packet content", () => {
  const original = plain(emit());
  const mutate = (callback) => { const value = structuredClone(original); callback(value); return packet(value); };
  const malformed = [
    "", "other " + JSON.stringify(original), WORKER_PREFIX + "{", WORKER_PREFIX + "x".repeat(MAX_PACKET_BYTES),
    mutate((v) => { v.secret = "DO_NOT_COPY"; }),
    mutate((v) => { v.name = "line\nname"; }),
    mutate((v) => { v.name = "C:\\secret"; }),
    mutate((v) => { v.workers[0].message = "DO_NOT_COPY"; }),
    mutate((v) => { v.workers[0].scriptStage = "DO_NOT_COPY"; }),
    mutate((v) => { v.workers[0].elapsedMs = 60001; }),
    mutate((v) => { v.workers[0].depth = 5; }),
    mutate((v) => { v.workers[0].activityCPUTimeUs.userScriptUs = 0.5; }),
    mutate((v) => { v.workers[0].scriptDiagnostics.bootstrapOperation = "DO_NOT_COPY"; }),
    mutate((v) => { v.workers[0].scriptDiagnostics.sql = "DO_NOT_COPY"; }),
    mutate((v) => { v.workers = []; }),
    mutate((v) => { v.availability = "unavailable"; }),
    WORKER_PREFIX + '{"version":1,"availability":"capped","__proto__":{}}',
  ];
  for (const value of malformed) assert.equal(parseWorkerDiagnostic(value), undefined);
});

test("observer guard accepts only an explicit repository test-file main process", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "core-observer-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "tests"));
  const entry = path.join(root, "tests/safe.test.mjs");
  await writeFile(entry, "// pure fixture\n");
  const valid = { mainThread: true, context: "child-v8", entry, repositoryRoot: root };
  assert.equal(eligibleObserverEntry(valid), true);
  let stats = 0;
  const stat = () => { stats++; return { isFile: () => true }; };
  for (const changes of [
    { mainThread: false }, { context: undefined }, { context: "child" },
    { entry: undefined }, { entry: path.join(root, "src/script-worker.mjs") },
    { entry: path.join(root, "tests/cli.mjs") }, { entry: path.join(root, "tests/.hidden.test.mjs") },
    { entry: path.join(root, "tests/nested/child.test.mjs") },
    { entry: path.join(root, "outside.test.mjs") }, { entry: path.join(root, "tests/a?.test.mjs") },
  ]) assert.equal(eligibleObserverEntry({ ...valid, ...changes }, stat), false);
  assert.equal(stats, 0);
  assert.equal(eligibleObserverEntry(valid, () => { throw Error("stat unavailable"); }), false);
  assert.equal(eligibleObserverEntry(valid, () => ({ isFile: () => false })), false);
  await mkdir(path.join(root, "tests/directory.test.mjs"));
  assert.equal(eligibleObserverEntry({ ...valid, entry: path.join(root, "tests/directory.test.mjs") }), false);
  // Windows symlink privileges differ; the ordinary lstat guard is also checked
  // with an inert non-regular-file stat above, with no skip/test-count changes.
  if (process.platform !== "win32") {
    const link = path.join(root, "tests/link.test.mjs");
    await symlink(entry, link);
    assert.equal(eligibleObserverEntry({ ...valid, entry: link }), false);
  }
});
