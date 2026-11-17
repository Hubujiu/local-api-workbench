import test from "node:test";
import assert, { AssertionError } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  executionResultMetadata,
  createExecutionResultDiagnostics,
  withExecutionResultDiagnostics,
  EXECUTION_RESULT_PREFIX,
  MAX_EXECUTION_RESULT_PACKET_BYTES,
  MAX_EXECUTION_RESULT_PACKETS,
  MAX_EXECUTION_RESULT_BYTES,
} from "./helpers/execution-result-diagnostics.mjs";

// Synthetic public records only. Never import the application, XML or VM.
const plain = (value) => JSON.parse(JSON.stringify(value));
const diagnostics = {
  activityBudgetMs: 249.5,
  fakerCalls: 1001,
  mockCalls: 1000,
  mockNodes: 10000,
  mockBytes: 1048576,
  timerCount: 101,
  requestCount: 11,
  compatibilityCPUUs: 60000000,
  functionLibraryCPUUs: 60000000,
  userScriptCPUUs: 60000000,
  microtaskCPUUs: 60000000,
  callbackCPUUs: 60000000,
  promiseStateCPUUs: 60000000,
  serializationCPUUs: 60000000,
  compatibilityMs: 60000,
  fakerLoadMs: 60000,
  functionLibraryMs: 60000,
  userScriptMs: 60000,
  microtaskMs: 60000,
  callbackMs: 60000,
  promiseStateMs: 60000,
  serializationMs: 60000,
  elapsedMs: 60000,
  bootstrapElapsedMs: 60000,
  bootstrapOperationMs: 60000,
  bootstrapCPUUs: 60000000,
  bootstrapOperationCPUUs: 60000000,
  bootstrapOperation: "trusted-libraries",
  activityOperation: "promise-state",
  lastWorkerStage: "script",
};
const record = () => ({
  status: "failed",
  error: "脚本执行超时",
  scriptStage: "bootstrap",
  scriptDiagnostics: { ...diagnostics },
});
const failure = () =>
  new AssertionError({
    actual: undefined,
    expected: false,
    operator: "strictEqual",
    message: "original assertion",
  });
function observe(
  result,
  error = failure(),
  wrap = createExecutionResultDiagnostics(),
) {
  let caught;
  try {
    wrap(result, () => {
      throw error;
    });
  } catch (value) {
    caught = value;
  }
  assert.equal(caught, error);
  return error;
}
const packet = (error) =>
  JSON.parse(error.message.split(EXECUTION_RESULT_PREFIX)[1]);

test("execution result retains the complete flattened public numeric format", () => {
  const value = executionResultMetadata(record());
  assert.deepEqual(plain(value), {
    version: 1,
    availability: "observed",
    status: "failed",
    errorClass: "script-timeout",
    scriptStage: "bootstrap",
    scriptDiagnostics: diagnostics,
  });
  assert.equal(Object.getPrototypeOf(value), null);
  assert.equal(Object.getPrototypeOf(value.scriptDiagnostics), null);
  const error = observe(record());
  assert.deepEqual(packet(error), plain(value));
  assert(
    Buffer.byteLength(EXECUTION_RESULT_PREFIX + JSON.stringify(value)) <=
      MAX_EXECUTION_RESULT_PACKET_BYTES,
  );
});

test("execution result copies no private fields, text, objects or dynamic names", () => {
  const secret =
    "SECRET https://user:password@private.test/?token=secret ".repeat(10000);
  const input = record();
  Object.assign(input, {
    error: secret,
    body: secret,
    url: secret,
    scriptScope: secret,
    name: secret,
    assertions: [{ name: secret }],
    variables: { token: secret },
  });
  Object.assign(input.scriptDiagnostics, {
    body: secret,
    scriptScope: secret,
    arbitrary: { secret },
  });
  input.cycle = input;
  const value = plain(executionResultMetadata(input));
  assert.equal(value.errorClass, "other");
  assert.deepEqual(value.scriptDiagnostics, diagnostics);
  assert(!JSON.stringify(value).includes("SECRET"));
  assert(!JSON.stringify(value).includes("private.test"));
});

test("error classification is exact and missing metrics are never filled with zero", () => {
  for (const [input, classification] of [
    [{}, "none"],
    [{ error: "脚本执行超时" }, "script-timeout"],
    [{ error: "脚本执行超时 SECRET" }, "other"],
    [{ error: "" }, "other"],
    [
      {
        error: {
          toString() {
            throw Error("must not convert");
          },
        },
      },
      "other",
    ],
  ]) {
    assert.deepEqual(plain(executionResultMetadata(input)), {
      version: 1,
      availability: "observed",
      errorClass: classification,
    });
  }
  assert.deepEqual(
    plain(executionResultMetadata({ scriptDiagnostics: { userScriptMs: 0 } }))
      .scriptDiagnostics,
    { userScriptMs: 0 },
  );
});

test("unknown enums and invalid numeric values are omitted rather than coerced", () => {
  for (const bad of [-1, Infinity, NaN, 60000001, "1", null, {}, 0.1]) {
    const value = plain(
      executionResultMetadata({
        status: "SECRET",
        scriptStage: "SECRET",
        scriptDiagnostics: {
          userScriptCPUUs: bad,
          timerCount: bad,
          activityOperation: "SECRET",
          lastWorkerStage: "SECRET",
        },
      }),
    );
    assert.deepEqual(value, {
      version: 1,
      availability: "observed",
      errorClass: "none",
    });
  }
  for (const bad of [251, -1, Infinity, "250"])
    assert.equal(
      executionResultMetadata({ scriptDiagnostics: { activityBudgetMs: bad } })
        .scriptDiagnostics,
      undefined,
    );
  assert.equal(
    executionResultMetadata({
      scriptStage: "script",
      scriptDiagnostics: { bootstrapCPUUs: 5, bootstrapOperation: "setup" },
    }).scriptDiagnostics,
    undefined,
  );
});

test("fixed stage, operation and status enums are retained", () => {
  for (const stage of [
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
  ])
    assert.equal(
      executionResultMetadata({ scriptStage: stage }).scriptStage,
      stage,
    );
  for (const operation of [
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
  ])
    assert.equal(
      executionResultMetadata({
        scriptDiagnostics: { activityOperation: operation },
      }).scriptDiagnostics.activityOperation,
      operation,
    );
  for (const status of ["passed", "failed", "cancelled", "skipped"])
    assert.equal(executionResultMetadata({ status }).status, status);
});

test("malformed records, custom prototypes and cyclic diagnostics are unavailable", () => {
  const cycle = {};
  cycle.scriptDiagnostics = cycle;
  for (const input of [
    null,
    undefined,
    [],
    1,
    "SECRET",
    Object.create({ status: "failed" }),
    cycle,
    { scriptDiagnostics: [] },
    { scriptDiagnostics: "SECRET" },
  ])
    assert.deepEqual(plain(executionResultMetadata(input)), {
      version: 1,
      availability: "unavailable",
      errorClass: "unavailable",
    });
});

test("proxy and revoked-proxy records never invoke a trap", () => {
  let calls = 0;
  const proxy = new Proxy(
    {},
    {
      get() {
        calls++;
        throw Error("get");
      },
      getPrototypeOf() {
        calls++;
        throw Error("prototype");
      },
      getOwnPropertyDescriptor() {
        calls++;
        throw Error("descriptor");
      },
      ownKeys() {
        calls++;
        throw Error("keys");
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const input of [
    proxy,
    revoked.proxy,
    { scriptDiagnostics: proxy },
    { scriptDiagnostics: revoked.proxy },
  ])
    assert.equal(executionResultMetadata(input).availability, "unavailable");
  assert.equal(calls, 0);
});

test("selected getters and toJSON are rejected without invocation", () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw Error("getter");
  };
  for (const key of [
    "error",
    "status",
    "scriptStage",
    "scriptDiagnostics",
    "toJSON",
  ]) {
    const input = record();
    Object.defineProperty(input, key, { get: trap });
    assert.equal(executionResultMetadata(input).availability, "unavailable");
  }
  for (const key of ["userScriptMs", "activityOperation", "toJSON"]) {
    const input = record();
    Object.defineProperty(input.scriptDiagnostics, key, { get: trap });
    assert.equal(executionResultMetadata(input).availability, "unavailable");
  }
  assert.equal(
    executionResultMetadata({ toJSON: trap }).availability,
    "unavailable",
  );
  assert.equal(calls, 0);
});

test("prototype pollution is rejected before observation or serialization", () => {
  let calls = 0;
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    get() {
      calls++;
      throw Error("polluted");
    },
  });
  let value, caught;
  const error = failure(),
    before = error.message;
  try {
    value = executionResultMetadata(record());
    try {
      withExecutionResultDiagnostics(record(), () => {
        throw error;
      });
    } catch (e) {
      caught = e;
    }
  } finally {
    delete Object.prototype.toJSON;
  }
  assert.equal(value.availability, "unavailable");
  assert.equal(caught, error);
  assert.equal(error.message, before);
  assert.equal(calls, 0);
});

test("captured builtins remain usable after public methods are replaced", () => {
  const originals = {
    descriptor: Object.getOwnPropertyDescriptor,
    hasOwn: Object.hasOwn,
    stringify: JSON.stringify,
    finite: Number.isFinite,
    byteLength: Buffer.byteLength,
    define: Object.defineProperty,
  };
  const trap = () => {
    throw Error("replaced builtin");
  };
  let value,
    error = failure();
  try {
    Object.getOwnPropertyDescriptor =
      Object.hasOwn =
      JSON.stringify =
      Number.isFinite =
      Buffer.byteLength =
      Object.defineProperty =
        trap;
    value = executionResultMetadata(record());
    try {
      withExecutionResultDiagnostics(record(), () => {
        throw error;
      });
    } catch (e) {
      if (e !== error) throw e;
    }
  } finally {
    Object.getOwnPropertyDescriptor = originals.descriptor;
    Object.hasOwn = originals.hasOwn;
    JSON.stringify = originals.stringify;
    Number.isFinite = originals.finite;
    Buffer.byteLength = originals.byteLength;
    Object.defineProperty = originals.define;
  }
  assert.equal(value.errorClass, "script-timeout");
  assert.equal(packet(error).errorClass, "script-timeout");
});

test("original failure identity and actual/expected/operator survive annotation", () => {
  const error = failure();
  const before = {
    actual: error.actual,
    expected: error.expected,
    operator: error.operator,
    stack: error.stack,
    message: error.message,
  };
  observe(record(), error);
  assert.equal(error.actual, before.actual);
  assert.equal(error.expected, before.expected);
  assert.equal(error.operator, before.operator);
  assert.equal(error.stack, before.stack);
  assert(error.message.startsWith(before.message + EXECUTION_RESULT_PREFIX));
  const typeError = new TypeError("missing assertion entry");
  observe(record(), typeError);
  assert.equal(packet(typeError).errorClass, "script-timeout");
});

test("success does not inspect the supplied result and preserves synchronous values", () => {
  let calls = 0;
  const input = new Proxy(
    {},
    {
      get() {
        calls++;
        throw Error("get");
      },
      getOwnPropertyDescriptor() {
        calls++;
        throw Error("descriptor");
      },
      getPrototypeOf() {
        calls++;
        throw Error("prototype");
      },
    },
  );
  const wrap = createExecutionResultDiagnostics(),
    returned = {};
  assert.equal(
    wrap(input, () => assert.equal(1, 1)),
    undefined,
  );
  assert.equal(
    wrap(input, () => returned),
    returned,
  );
  assert.equal(
    wrap(input, () => 7),
    7,
  );
  assert.equal(calls, 0);
});

test("observation failure cannot replace the original exception", () => {
  const wrap = createExecutionResultDiagnostics();
  for (const error of [
    "primitive",
    null,
    {},
    new Proxy(
      {},
      {
        get() {
          throw Error("proxy");
        },
      },
    ),
  ])
    observe(record(), error, wrap);
  const getterError = failure();
  Object.defineProperty(getterError, "message", {
    get() {
      throw Error("message getter");
    },
  });
  observe(record(), getterError, wrap);
});

test("frozen messages and oversized original messages remain untouched", () => {
  const wrap = createExecutionResultDiagnostics();
  for (const error of [
    Object.freeze(failure()),
    new Error("x".repeat(1000000)),
  ]) {
    const before = error.message;
    observe(record(), error, wrap);
    assert.equal(error.message, before);
  }
  const error = failure();
  Object.defineProperty(error, "message", { writable: false });
  const before = error.message;
  observe(record(), error, wrap);
  assert.equal(error.message, before);
});

test("the same failure is annotated once even through nested wrappers", () => {
  const error = failure(),
    wrap = createExecutionResultDiagnostics();
  observe(record(), error, wrap);
  const once = error.message;
  observe(record(), error, wrap);
  assert.equal(error.message, once);
  observe(record(), error, createExecutionResultDiagnostics());
  assert.equal(error.message, once);
});

test("packet quota bounds a file's diagnostic volume", async () => {
  const isolated = await import(
    "./helpers/execution-result-diagnostics.mjs?packet-quota"
  );
  const wrap = isolated.createExecutionResultDiagnostics();
  let count = 0,
    bytes = 0;
  for (let i = 0; i < MAX_EXECUTION_RESULT_PACKETS + 10; i++) {
    const error = observe({}, failure(), wrap),
      at = error.message.indexOf(EXECUTION_RESULT_PREFIX);
    if (at >= 0) {
      count++;
      bytes += Buffer.byteLength(error.message.slice(at));
    }
  }
  assert.equal(count, MAX_EXECUTION_RESULT_PACKETS);
  assert(bytes <= MAX_EXECUTION_RESULT_BYTES);
  const freshWrapper = isolated.createExecutionResultDiagnostics();
  const untouched = failure(),
    original = untouched.message;
  observe(record(), untouched, freshWrapper);
  assert.equal(
    untouched.message,
    original,
    "a new wrapper does not reset the file quota",
  );
});

test("byte quota stops full-format packets before the count quota", async () => {
  const isolated = await import(
    "./helpers/execution-result-diagnostics.mjs?byte-quota"
  );
  const wrap = isolated.createExecutionResultDiagnostics();
  let count = 0,
    bytes = 0;
  for (let i = 0; i < MAX_EXECUTION_RESULT_PACKETS + 10; i++) {
    const error = observe(record(), failure(), wrap),
      at = error.message.indexOf(EXECUTION_RESULT_PREFIX);
    if (at >= 0) {
      const size = Buffer.byteLength(error.message.slice(at));
      assert(size <= MAX_EXECUTION_RESULT_PACKET_BYTES);
      count++;
      bytes += size;
    }
  }
  assert(count > 0 && count < MAX_EXECUTION_RESULT_PACKETS);
  assert(bytes <= MAX_EXECUTION_RESULT_BYTES);
});

test("async callbacks and promise/thenable returns explicitly violate the synchronous contract", () => {
  const wrap = createExecutionResultDiagnostics();
  let calls = 0;
  assert.throws(
    () =>
      wrap({}, async () => {
        calls++;
      }),
    /synchronous assertion/,
  );
  assert.equal(calls, 0);
  assert.throws(
    () => wrap({}, () => Promise.resolve()),
    /synchronous assertion/,
  );
  assert.throws(
    () =>
      wrap({}, () => ({
        then() {
          calls++;
        },
      })),
    /synchronous assertion/,
  );
  assert.throws(
    () =>
      wrap({}, () =>
        Object.create({
          then() {
            calls++;
          },
        }),
      ),
    /synchronous assertion/,
  );
  assert.throws(
    () =>
      wrap({}, () => ({
        get then() {
          calls++;
          throw Error("getter");
        },
      })),
    /synchronous assertion/,
  );
  assert.equal(calls, 0);
});

test("util type predicates are captured before syncBuiltinESMExports replacement", () => {
  const helperURL = new URL(
    "./helpers/execution-result-diagnostics.mjs",
    import.meta.url,
  ).href;
  for (const attack of ["throw", "misclassify"]) {
    // A fresh pure subprocess contains the global builtin-export mutation. No
    // application, dependency, XML parser, network or VM is loaded or executed.
    const source = `
      import assert, { AssertionError } from "node:assert/strict";
      import types from "node:util/types";
      import { syncBuiltinESMExports } from "node:module";
      const api = await import(${JSON.stringify(helperURL)});
      let maliciousCalls = 0, proxyCalls = 0, assertionCalls = 0;
      for (const key of ["isProxy", "isNativeError", "isPromise", "isAsyncFunction"])
        types[key] = () => {
          maliciousCalls++;
          if (${JSON.stringify(attack)} === "throw") throw Error("malicious builtin called");
          return false;
        };
      syncBuiltinESMExports();
      const proxy = new Proxy({}, {
        getPrototypeOf() { proxyCalls++; throw Error("proxy prototype trap"); },
        getOwnPropertyDescriptor() { proxyCalls++; throw Error("proxy descriptor trap"); },
        get() { proxyCalls++; throw Error("proxy get trap"); },
      });
      assert.equal(api.executionResultMetadata(proxy).availability, "unavailable");
      const revoked = Proxy.revocable({}, {}); revoked.revoke();
      assert.equal(api.executionResultMetadata(revoked.proxy).availability, "unavailable");
      assert.equal(api.executionResultMetadata({ status: "failed", error: "脚本执行超时" }).errorClass, "script-timeout");
      assert.equal(api.withExecutionResultDiagnostics(proxy, () => { assertionCalls++; return 7; }), 7);
      const error = new AssertionError({ actual: undefined, expected: false, operator: "strictEqual", message: "original" });
      let caught;
      try { api.withExecutionResultDiagnostics({ error: "脚本执行超时" }, () => { assertionCalls++; throw error; }); }
      catch (value) { caught = value; }
      assert.equal(caught, error);
      assert.equal(error.actual, undefined);
      assert.equal(error.expected, false);
      assert.equal(error.operator, "strictEqual");
      assert(error.message.includes(api.EXECUTION_RESULT_PREFIX));
      assert.throws(() => api.withExecutionResultDiagnostics({}, async () => { assertionCalls++; }), /synchronous assertion/);
      assert.throws(() => api.withExecutionResultDiagnostics({}, () => Promise.resolve()), /synchronous assertion/);
      assert.equal(assertionCalls, 2);
      assert.equal(maliciousCalls, 0);
      assert.equal(proxyCalls, 0);
      process.stdout.write("CAPTURED_TYPE_PREDICATES_PASS\\n");
    `;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 128 * 1024,
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "CAPTURED_TYPE_PREDICATES_PASS\n");
  }
});
