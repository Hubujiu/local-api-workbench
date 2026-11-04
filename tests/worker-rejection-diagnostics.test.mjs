import test from "node:test";
import assert, { AssertionError } from "node:assert/strict";
import {
  workerFailureMetadata,
  withWorkerRejectionDiagnostics,
} from "./helpers/worker-rejection-diagnostics.mjs";
import { withWorkerPhaseDiagnostics } from "./helpers/worker-phase-diagnostics.mjs";

// Pure synthetic fixtures only: no script runtime, native XML, or VM imports.
const prefix = "\nWORKER_REJECTION_METADATA ";
const plain = (value) => JSON.parse(JSON.stringify(value));
const expected = {
  scriptStage: "script",
  lastWorkerStage: "compatibility",
  activityOperation: "native-assertion-evidence",
  elapsedMs: 60000,
  scriptDiagnostics: {
    activityBudgetMs: 250,
    fakerCalls: 1001,
    timerCount: 101,
    requestCount: 11,
  },
  activityMetrics: {
    compatibilityMs: 60000,
    functionLibraryMs: 60000,
    userScriptMs: 60000,
    microtaskMs: 60000,
    callbackMs: 60000,
    promiseStateMs: 60000,
    serializationMs: 60000,
    fakerLoadMs: 60000,
  },
  activityCPUTimeUs: {
    compatibilityUs: 60000000,
    functionLibraryUs: 60000000,
    userScriptUs: 60000000,
    microtaskUs: 60000000,
    callbackUs: 60000000,
    promiseStateUs: 60000000,
    serializationUs: 60000000,
  },
};
const mismatch = async (error) => {
  let failure;
  try {
    await withWorkerRejectionDiagnostics((capture) =>
      assert.rejects(Promise.reject(error).catch(capture), /自有字符串/),
    );
  } catch (caught) {
    failure = caught;
  }
  assert(failure instanceof AssertionError);
  return failure;
};

test("worker metadata retains only explicit raw fields at their accepted caps", () => {
  assert.deepEqual(plain(workerFailureMetadata(expected)), expected);
  assert.equal(Object.getPrototypeOf(workerFailureMetadata(expected)), null);
  assert.equal(
    Object.getPrototypeOf(workerFailureMetadata(expected).activityMetrics),
    null,
  );
});

test("worker metadata accepts only the known stage and operation enums", () => {
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
    assert.deepEqual(
      plain(
        workerFailureMetadata({ scriptStage: stage, lastWorkerStage: stage }),
      ),
      { scriptStage: stage, lastWorkerStage: stage },
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
    assert.deepEqual(
      plain(workerFailureMetadata({ activityOperation: operation })),
      { activityOperation: operation },
    );
  for (const value of ["unknown", "script/path", "script\nsecret", 0, {}, null])
    assert.deepEqual(
      plain(
        workerFailureMetadata({
          scriptStage: value,
          lastWorkerStage: value,
          activityOperation: value,
        }),
      ),
      {},
    );
});

test("worker metadata omits secret-bearing objects, text and arbitrary diagnostic fields", () => {
  const secret = "SECRET /private/path SELECT * FROM credentials ".repeat(100);
  const extras = {
    message: secret,
    stack: secret,
    source: secret,
    body: secret,
    variables: { token: secret },
    networkRequests: [{ url: secret }],
    databaseQueries: [{ sql: secret }],
    sql: secret,
    path: secret,
    scriptScope: secret,
    compatibilityCPUUs: 12,
    unknown: secret,
  };
  const error = Object.assign(new Error(secret), extras, expected, {
    scriptDiagnostics: { ...expected.scriptDiagnostics, ...extras },
    activityMetrics: { ...expected.activityMetrics, ...extras },
    activityCPUTimeUs: { ...expected.activityCPUTimeUs, ...extras },
  });
  const metadata = workerFailureMetadata(error);
  assert.deepEqual(plain(metadata), expected);
  assert(!JSON.stringify(metadata).includes("SECRET"));
});

test("worker metadata never invokes getters, toJSON or conversion hooks", () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw Error("diagnostic getter invoked");
  };
  const error = {};
  for (const [key, value] of Object.entries(expected)) {
    Object.defineProperty(error, key, { get: trap, configurable: true });
    if (value && typeof value === "object") {
      const nested = Object.create({ inherited: "ignored" });
      for (const name of Object.keys(value))
        Object.defineProperty(nested, name, { get: trap });
      Object.defineProperty(error, key, { value: nested });
    }
  }
  for (const key of ["message", "stack", "toJSON", "source", "body"])
    Object.defineProperty(error, key, { get: trap });
  assert.deepEqual(plain(workerFailureMetadata(error)), {});
  const coercible = { toJSON: trap, toString: trap, valueOf: trap };
  assert.deepEqual(
    plain(
      workerFailureMetadata({
        scriptStage: coercible,
        elapsedMs: coercible,
        scriptDiagnostics: { activityBudgetMs: coercible, toJSON: trap },
      }),
    ),
    {},
  );
  assert.equal(calls, 0);
});

test("worker metadata ignores inherited fields and proxies without invoking their traps", () => {
  const inherited = Object.create(expected);
  assert.deepEqual(plain(workerFailureMetadata(inherited)), {});
  assert.deepEqual(
    plain(
      workerFailureMetadata({
        scriptDiagnostics: Object.create(expected.scriptDiagnostics),
      }),
    ),
    {},
  );
  let calls = 0;
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        calls++;
        throw Error("proxy trap invoked");
      },
      get() {
        calls++;
        throw Error("proxy get invoked");
      },
    },
  );
  assert.deepEqual(plain(workerFailureMetadata(proxy)), {});
  assert.deepEqual(
    plain(workerFailureMetadata({ activityMetrics: proxy })),
    {},
  );
  assert.equal(calls, 0);
});

test("worker metadata preserves zero and rejects nonfinite, negative, oversized and nonnumeric values", () => {
  for (const [group, fields] of Object.entries(expected)) {
    if (!fields || typeof fields !== "object") continue;
    for (const [key, max] of Object.entries(fields)) {
      for (const value of [
        NaN,
        Infinity,
        -Infinity,
        -1,
        max + 1,
        "1",
        1n,
        {},
        null,
        undefined,
      ])
        assert.deepEqual(
          plain(workerFailureMetadata({ [group]: { [key]: value } })),
          {},
        );
      assert.deepEqual(
        plain(workerFailureMetadata({ [group]: { [key]: 0 } })),
        { [group]: { [key]: 0 } },
      );
      assert.deepEqual(
        plain(workerFailureMetadata({ [group]: { [key]: 0.5 } })),
        key === "activityBudgetMs" ? { [group]: { [key]: 0.5 } } : {},
      );
    }
  }
  for (const elapsedMs of [NaN, Infinity, -Infinity, -1, 60001, 0.5, "1", 1n])
    assert.deepEqual(plain(workerFailureMetadata({ elapsedMs })), {});
  assert.deepEqual(plain(workerFailureMetadata({ elapsedMs: 0 })), {
    elapsedMs: 0,
  });
  for (const value of [null, undefined, false, 0, "secret", 1n])
    assert.deepEqual(plain(workerFailureMetadata(value)), {});
});

test("a passing rejection assertion inspects no worker metadata and invokes its workload once", async () => {
  const workerError = Error("自有字符串");
  let calls = 0;
  let metadataReads = 0;
  Object.defineProperty(workerError, "scriptDiagnostics", {
    get() {
      metadataReads++;
      throw Error("must not inspect passing rejection");
    },
  });
  const before = Object.getOwnPropertyDescriptors(workerError);
  const phase = () => {
    calls++;
    return Promise.reject(workerError);
  };
  await withWorkerRejectionDiagnostics((capture) =>
    assert.rejects(phase().catch(capture), /自有字符串/),
  );
  assert.equal(calls, 1);
  assert.equal(metadataReads, 0);
  assert.deepEqual(Object.getOwnPropertyDescriptors(workerError), before);
});

test("a mismatch appends bounded JSON only to the same assertion failure and preserves the original rejection", async () => {
  const workerError = Object.assign(Error("interrupted"), expected);
  const before = Object.getOwnPropertyDescriptors(workerError);
  let assertionFailure;
  let originalMessage;
  let calls = 0;
  const phase = () => {
    calls++;
    return Promise.reject(workerError);
  };
  await assert.rejects(
    withWorkerRejectionDiagnostics(async (capture) => {
      try {
        await assert.rejects(phase().catch(capture), /自有字符串/);
      } catch (failure) {
        assertionFailure = failure;
        originalMessage = failure.message;
        throw failure;
      }
    }),
    (failure) => {
      assert.equal(failure, assertionFailure);
      assert.equal(failure.actual, workerError);
      assert.equal(failure.expected.source, "自有字符串");
      assert.equal(failure.code, "ERR_ASSERTION");
      assert.equal(
        failure.message.slice(0, originalMessage.length),
        originalMessage,
      );
      const suffix = failure.message.slice(originalMessage.length);
      assert(suffix.startsWith(prefix));
      assert(Buffer.byteLength(suffix, "utf8") <= 2048);
      assert.deepEqual(JSON.parse(suffix.slice(prefix.length)), expected);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(Object.getOwnPropertyDescriptors(workerError), before);
});

test("unexpected fulfillment still fails the original assertion once with empty metadata", async () => {
  let calls = 0;
  await assert.rejects(
    withWorkerRejectionDiagnostics((capture) => {
      calls++;
      return assert.rejects(Promise.resolve().catch(capture), /自有字符串/);
    }),
    (failure) => {
      assert(failure instanceof AssertionError);
      assert.match(failure.message, /Missing expected rejection/);
      assert(failure.message.endsWith(prefix + "{}"));
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("non-assertion failures pass through unchanged and no rejection is wrapped", async () => {
  const workerError = Object.assign(Error("interrupted"), expected);
  const before = Object.getOwnPropertyDescriptors(workerError);
  await assert.rejects(
    withWorkerRejectionDiagnostics((capture) =>
      Promise.reject(workerError).catch(capture),
    ),
    (failure) => failure === workerError,
  );
  assert.deepEqual(Object.getOwnPropertyDescriptors(workerError), before);
  const failure = await mismatch(workerError);
  assert.equal(failure.actual, workerError);
});

test("labelled phase success returns the same value once without inspecting metadata", async () => {
  let calls = 0;
  let reads = 0;
  const value = Object.defineProperty({}, "scriptStage", {
    get() {
      reads++;
      throw Error("must not inspect a successful result");
    },
  });
  const result = await withWorkerPhaseDiagnostics("ascii-64k", () => {
    calls++;
    return value;
  });
  assert.equal(result, value);
  assert.equal(calls, 1);
  assert.equal(reads, 0);
});

test("labelled expected rejection matches its original regex before any metadata observation", async () => {
  const workerError = Error("invalid Unicode");
  let calls = 0;
  let reads = 0;
  Object.defineProperty(workerError, "scriptStage", {
    get() {
      reads++;
      throw Error("must not inspect an expected rejection");
    },
  });
  const before = Object.getOwnPropertyDescriptors(workerError);
  await withWorkerPhaseDiagnostics("invalid-unicode", (capture) => {
    calls++;
    return assert.rejects(
      Promise.reject(workerError).catch(capture),
      /Unicode/,
    );
  });
  assert.equal(calls, 1);
  assert.equal(reads, 0);
  assert.deepEqual(Object.getOwnPropertyDescriptors(workerError), before);
});

test("a label matching the expected regex cannot turn interrupted into an accepted rejection", async () => {
  for (const expectedPattern of [/Unicode/, /unicode/, /invalid-unicode/]) {
    const workerError = Object.assign(Error("interrupted"), expected);
    const before = Object.getOwnPropertyDescriptors(workerError);
    let originalFailure;
    let originalMessage;
    let calls = 0;
    await assert.rejects(
      withWorkerPhaseDiagnostics("invalid-unicode", async (capture) => {
        calls++;
        try {
          await assert.rejects(
            Promise.reject(workerError).catch(capture),
            expectedPattern,
          );
        } catch (failure) {
          originalFailure = failure;
          originalMessage = failure.message;
          throw failure;
        }
      }),
      (failure) => {
        assert(failure instanceof AssertionError);
        assert.equal(failure, originalFailure);
        assert.equal(failure.actual, workerError);
        assert.equal(failure.expected, expectedPattern);
        assert.equal(failure.code, "ERR_ASSERTION");
        assert.equal(
          failure.message.slice(0, originalMessage.length),
          originalMessage,
        );
        const marker = "\nWORKER_PHASE invalid-unicode" + prefix;
        const suffix = failure.message.slice(originalMessage.length);
        assert(suffix.startsWith(marker));
        assert(Buffer.byteLength(suffix, "utf8") <= 2048);
        assert.deepEqual(JSON.parse(suffix.slice(marker.length)), expected);
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(Object.getOwnPropertyDescriptors(workerError), before);
  }
});

test("unexpected labelled success-path rejection retains its original Error and bounded metadata", async () => {
  const workerError = Object.assign(Error("interrupted"), expected, {
    body: "never copy response content",
    request: { secret: "never copy request content" },
  });
  const before = Object.getOwnPropertyDescriptors(workerError);
  let calls = 0;
  await assert.rejects(
    withWorkerPhaseDiagnostics("ascii-64k", () => {
      calls++;
      return Promise.reject(workerError);
    }),
    (failure) => {
      assert.equal(failure, workerError);
      const marker = "\nWORKER_PHASE ascii-64k" + prefix;
      const suffix = failure.message.slice(before.message.value.length);
      assert.equal(
        failure.message.slice(0, before.message.value.length),
        "interrupted",
      );
      assert(suffix.startsWith(marker));
      assert(Buffer.byteLength(suffix, "utf8") <= 2048);
      assert.deepEqual(JSON.parse(suffix.slice(marker.length)), expected);
      const after = Object.getOwnPropertyDescriptors(failure);
      after.message.value = before.message.value;
      assert.deepEqual(after, before);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("labelled unexpected fulfillment remains the original missing-rejection assertion", async () => {
  let originalFailure;
  let calls = 0;
  await assert.rejects(
    withWorkerPhaseDiagnostics("invalid-unicode", async (capture) => {
      calls++;
      try {
        await assert.rejects(Promise.resolve().catch(capture), /Unicode/);
      } catch (failure) {
        originalFailure = failure;
        throw failure;
      }
    }),
    (failure) => {
      assert.equal(failure, originalFailure);
      assert(failure instanceof AssertionError);
      assert.match(failure.message, /Missing expected rejection/);
      assert(
        failure.message.endsWith(
          "\nWORKER_PHASE invalid-unicode" + prefix + "{}",
        ),
      );
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("labelled metadata ignores throwing fields and malformed values without replacing failure", async () => {
  let reads = 0;
  const workerError = Object.defineProperties(Error("interrupted"), {
    scriptStage: {
      get() {
        reads++;
        throw Error("must not read stage");
      },
    },
    activityMetrics: {
      value: new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            reads++;
            throw Error("must not inspect proxy");
          },
        },
      ),
    },
    elapsedMs: { value: Infinity },
    activityCPUTimeUs: { value: { compatibilityUs: -1 } },
  });
  await assert.rejects(
    withWorkerPhaseDiagnostics("depth-32", () => Promise.reject(workerError)),
    (failure) => {
      assert.equal(failure, workerError);
      assert.equal(
        failure.message,
        "interrupted\nWORKER_PHASE depth-32" + prefix + "{}",
      );
      return true;
    },
  );
  assert.equal(reads, 0);
});

test("unwritable, accessor, proxy and primitive failures pass through without diagnostic effects", async () => {
  let reads = 0;
  const frozen = Object.freeze(Error("frozen"));
  const accessor = Object.defineProperty(Error("accessor"), "message", {
    get() {
      reads++;
      throw Error("must not read message");
    },
  });
  const proxy = new Proxy(Error("proxy"), {
    get() {
      reads++;
      throw Error("must not read proxy");
    },
    getPrototypeOf() {
      reads++;
      throw Error("must not inspect proxy");
    },
    getOwnPropertyDescriptor() {
      reads++;
      throw Error("must not inspect proxy");
    },
  });
  for (const original of [
    frozen,
    accessor,
    proxy,
    null,
    undefined,
    "failure",
    0,
  ]) {
    let caught = Symbol("not rejected");
    try {
      await withWorkerPhaseDiagnostics("depth-32", () =>
        Promise.reject(original),
      );
    } catch (failure) {
      caught = failure;
    }
    assert.equal(caught, original);
  }
  assert.equal(reads, 0);
});

test("invalid diagnostic labels and observer exceptions cannot replace the workload failure", async () => {
  for (const label of ["", "secret text", "x".repeat(65), null, undefined]) {
    const original = Error("interrupted");
    await assert.rejects(
      withWorkerPhaseDiagnostics(label, () => Promise.reject(original)),
      (failure) => failure === original && failure.message === "interrupted",
    );
  }
  const original = Error("interrupted");
  const observerError = Error("observer must not replace workload error");
  Object.setPrototypeOf(
    original,
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw observerError;
        },
      },
    ),
  );
  let caught;
  try {
    await withWorkerPhaseDiagnostics("depth-32", () =>
      Promise.reject(original),
    );
  } catch (failure) {
    caught = failure;
  }
  assert.equal(caught, original);
  assert.equal(caught.message, "interrupted");
});
