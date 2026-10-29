import assert, { AssertionError } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  cliResultMetadata,
  withCLIResultDiagnostics,
  workflowFailureObservations,
} from "./helpers/cli-result-diagnostics.mjs";

const secret = "PRIVATE_BODY_TOKEN_PATH_SOURCE";
const fixture = () => ({
  status: "failed",
  name: secret,
  error: { message: secret },
  variables: secret,
  results: [
    { status: "passed", body: secret },
    {
      status: "failed",
      scriptStage: "script",
      name: secret,
      scriptScope: secret,
      response: { body: secret },
      error: { message: secret },
      scriptDiagnostics: {
        activityBudgetMs: 12.5,
        fakerCalls: 0,
        timerCount: 2,
        requestCount: 1,
        userScriptMs: 38,
        userScriptCPUUs: 1000,
        fakerLoadMs: 9,
        elapsedMs: 40,
        lastWorkerStage: "async-completion",
        activityOperation: "promise-state",
        source: secret,
        vars: secret,
      },
    },
  ],
});

test("retains only numeric/enumerated persisted diagnostics and zero-based index", () => {
  const metadata = cliResultMetadata(JSON.stringify(fixture()));
  assert.equal(metadata.resultCount, 2);
  assert.equal(metadata.steps[0].stepIndex, 1);
  assert.equal(metadata.steps[0].scriptDiagnostics.fakerCalls, 0);
  assert.equal(metadata.steps[0].scriptDiagnostics.activityBudgetMs, 12.5);
  assert.equal(metadata.steps[0].activityMetrics.userScriptMs, 38);
  assert.equal(metadata.steps[0].activityCPUTimeUs.userScriptUs, 1000);
  assert.equal(metadata.steps[0].lastWorkerStage, "async-completion");
  assert.equal(metadata.steps[0].activityOperation, "promise-state");
  assert.equal(metadata.steps[0].elapsedMs, 40);
  assert.ok(!JSON.stringify(metadata).includes(secret));
});

test("drops unknown labels, wrong types, negative, fractional and over-cap numbers", () => {
  const run = fixture();
  Object.assign(run.results[1], { status: secret, scriptStage: secret });
  Object.assign(run.results[1].scriptDiagnostics, {
    fakerCalls: 1002,
    timerCount: -1,
    requestCount: 1.2,
    activityBudgetMs: "12",
    userScriptMs: 60001,
    userScriptCPUUs: 60000001,
    elapsedMs: 60001,
    lastWorkerStage: secret,
    activityOperation: secret,
  });
  const step = cliResultMetadata(JSON.stringify(run)).steps[0];
  assert.equal(step.status, "unknown");
  assert.equal(step.scriptDiagnostics, undefined);
  assert.equal(step.activityCPUTimeUs, undefined);
  assert.deepEqual(Object.keys(step.activityMetrics), ["fakerLoadMs"]);
  assert.ok(!JSON.stringify(step).includes(secret));
});

test("malformed/truncated JSON and shape return fixed labels without data", () => {
  for (const text of ["{", '{"results":[', secret])
    assert.equal(cliResultMetadata(text).input, "invalid-json");
  for (const value of [null, 1, [], {}, { results: {} }])
    assert.equal(
      cliResultMetadata(JSON.stringify(value)).input,
      "invalid-shape",
    );
});

test("byte and code-unit input guards reject before parsing or coercion", () => {
  assert.equal(
    cliResultMetadata(" ".repeat(2 * 1024 * 1024 + 1)).input,
    "oversized",
  );
  assert.equal(cliResultMetadata("界".repeat(800000)).input, "oversized");
  const proxy = new Proxy(
    {},
    {
      get() {
        throw Error("must not read");
      },
    },
  );
  assert.equal(cliResultMetadata(proxy).input, "not-text");
});

test("bounded scan, retained steps and explicit omission counts", () => {
  const run = fixture();
  run.results = Array.from({ length: 250 }, () => run.results[1]);
  const metadata = cliResultMetadata(JSON.stringify(run));
  assert.equal(metadata.scannedCount, 200);
  assert.equal(metadata.unscannedCount, 50);
  assert.equal(metadata.omittedCount, 196);
  assert.equal(Object.keys(metadata.steps).length, 4);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) < 4096);
});

test("same assertion error, original message/expected/actual, one call", () => {
  const failure = new AssertionError({
    actual: 1,
    expected: 0,
    operator: "strictEqual",
    message: "original",
  });
  const originalMessage = failure.message;
  let calls = 0;
  assert.throws(
    () =>
      withCLIResultDiagnostics(() => {
        calls++;
        throw failure;
      }, JSON.stringify(fixture())),
    (error) => {
      assert.equal(error, failure);
      assert.equal(error.actual, 1);
      assert.equal(error.expected, 0);
      assert.ok(
        error.message.startsWith(originalMessage + "\nCLI_RESULT_METADATA "),
      );
      assert.ok(!error.message.includes(secret));
      assert.ok(
        Buffer.byteLength(error.message.slice(originalMessage.length)) <= 4096,
      );
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("successful assertion never parses stdout; nonassertion/read-only errors unchanged", () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw Error("must not read");
      },
    },
  );
  assert.equal(
    withCLIResultDiagnostics(() => 42, hostile),
    42,
  );
  const error = new Error("unchanged");
  assert.throws(
    () =>
      withCLIResultDiagnostics(() => {
        throw error;
      }, "{}"),
    (caught) => caught === error,
  );
  assert.equal(error.message, "unchanged");
  const failure = new AssertionError({ message: "read-only" });
  Object.defineProperty(failure, "message", { writable: false });
  assert.throws(
    () =>
      withCLIResultDiagnostics(() => {
        throw failure;
      }, "{}"),
    (caught) => caught === failure,
  );
  assert.equal(failure.message, "read-only");
});

test("pure synthetic subprocess emits retained evidence in failing TAP", () => {
  const helper = new URL(
    "./helpers/cli-result-diagnostics.mjs",
    import.meta.url,
  ).href;
  const source = `import test from 'node:test'; import assert from 'node:assert/strict';
    import { withCLIResultDiagnostics } from ${JSON.stringify(helper)};
    test('fabricated CLI failure', () => withCLIResultDiagnostics(
      () => assert.equal(1, 0, 'original'), ${JSON.stringify(JSON.stringify(fixture()))}));`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    { encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  const output = child.stdout + child.stderr;
  assert.match(output, /CLI_RESULT_METADATA/);
  assert.match(output, /userScriptUs/);
  assert.match(output, /stepIndex/);
  assert.ok(!output.includes(secret));
});

test("maximum whitelist values still produce bounded failure suffix", () => {
  const run = fixture();
  const diagnostic = run.results[1].scriptDiagnostics;
  for (const phase of [
    "compatibility",
    "functionLibrary",
    "userScript",
    "microtask",
    "callback",
    "promiseState",
    "serialization",
  ]) {
    diagnostic[phase + "Ms"] = 60000;
    diagnostic[phase + "CPUUs"] = 60000000;
  }
  run.results = Array.from({ length: 5 }, () => run.results[1]);
  const failure = new AssertionError({ message: "original" });
  const original = failure.message;
  assert.throws(
    () =>
      withCLIResultDiagnostics(() => {
        throw failure;
      }, JSON.stringify(run)),
    (error) => error === failure,
  );
  const suffix = failure.message.slice(original.length);
  assert.ok(Buffer.byteLength(suffix) <= 4096);
  assert.match(suffix, /CLI_RESULT_METADATA/);
  assert.ok(!suffix.includes(secret));
});

test("JSON proto keys cannot inject labels or serialization hooks", () => {
  const text =
    '{"results":[{"status":"failed","__proto__":{"scriptStage":"script"},"scriptDiagnostics":{"__proto__":{"requestCount":2},"toJSON":"PRIVATE_BODY_TOKEN_PATH_SOURCE"}}]}';
  const step = cliResultMetadata(text).steps[0];
  assert.equal(step.scriptStage, undefined);
  assert.equal(step.scriptDiagnostics, undefined);
  assert.ok(!JSON.stringify(step).includes(secret));
});

test("workflow observations retain only own fixed booleans and bounded hit counts", () => {
  const source = {
    loginRequestCount: 0,
    laterRequestCount: 16,
    hasRecordedResponse: false,
    body: secret,
    request: secret,
    phase: secret,
    script: secret,
    response: { body: secret },
  };
  const metadata = workflowFailureObservations(source);
  assert.equal(Object.getPrototypeOf(metadata), null);
  assert.deepEqual(
    { ...metadata },
    {
      loginRequestCount: 0,
      laterRequestCount: 16,
      hasRecordedResponse: false,
    },
  );
  assert.equal(
    workflowFailureObservations({ hasRecordedResponse: true })
      .hasRecordedResponse,
    true,
  );
  assert.ok(!JSON.stringify(metadata).includes(secret));
  for (const value of [-1, 17, 1.5, Infinity, NaN, "1", true, null, 1n]) {
    assert.deepEqual(
      {
        ...workflowFailureObservations({
          loginRequestCount: value,
          laterRequestCount: value,
        }),
      },
      {},
    );
  }
  for (const value of [0, 1, "true", null, undefined, {}, []])
    assert.deepEqual(
      { ...workflowFailureObservations({ hasRecordedResponse: value }) },
      {},
    );
});

test("workflow observations never read accessors, inherited values or proxy traps", () => {
  let reads = 0;
  const inherited = Object.create({
    loginRequestCount: 1,
    hasRecordedResponse: true,
  });
  Object.defineProperty(inherited, "laterRequestCount", {
    get() {
      reads++;
      throw Error("must not read observation getter");
    },
  });
  Object.defineProperty(inherited, "toJSON", {
    value() {
      reads++;
      throw Error("must not serialize observations");
    },
  });
  const proxy = new Proxy(
    {},
    {
      get() {
        reads++;
        throw Error("must not read proxy");
      },
      getOwnPropertyDescriptor() {
        reads++;
        throw Error("must not inspect proxy");
      },
    },
  );
  for (const source of [inherited, proxy, null, undefined, false, secret])
    assert.deepEqual({ ...workflowFailureObservations(source) }, {});
  assert.equal(reads, 0);
});

test("workflow evidence is appended only after original regex failure with identical assertion error", () => {
  for (const expectedPattern of [/XML|XPath|pickVars/, /loginRequestCount/]) {
    const run = fixture();
    run.results[1].error = "interrupted";
    const observations = {
      loginRequestCount: 1,
      laterRequestCount: 0,
      hasRecordedResponse: true,
      body: secret,
      phase: "XML",
    };
    let originalFailure;
    let originalMessage;
    let calls = 0;
    assert.throws(
      () =>
        withCLIResultDiagnostics(
          () => {
            calls++;
            try {
              assert.match(run.results[1].error, expectedPattern);
            } catch (failure) {
              originalFailure = failure;
              originalMessage = failure.message;
              throw failure;
            }
          },
          JSON.stringify(run),
          observations,
        ),
      (failure) => {
        assert.equal(failure, originalFailure);
        assert(failure instanceof AssertionError);
        assert.equal(failure.actual, "interrupted");
        assert.equal(failure.expected, expectedPattern);
        assert.equal(
          failure.message.slice(0, originalMessage.length),
          originalMessage,
        );
        const suffix = failure.message.slice(originalMessage.length);
        const marker = "\nCLI_RESULT_METADATA ";
        assert(suffix.startsWith(marker));
        assert(Buffer.byteLength(suffix) <= 4096);
        assert.deepEqual(
          JSON.parse(suffix.slice(marker.length)).workflowObservations,
          {
            loginRequestCount: 1,
            laterRequestCount: 0,
            hasRecordedResponse: true,
          },
        );
        assert.ok(!suffix.includes(secret));
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(run.results[1].error, "interrupted");
    assert.equal(observations.phase, "XML");
  }
});

test("successful assertions never inspect optional workflow observations and old calls keep their shape", () => {
  let reads = 0;
  const observations = new Proxy(
    {},
    {
      get() {
        reads++;
        throw Error("must not read successful observations");
      },
      getOwnPropertyDescriptor() {
        reads++;
        throw Error("must not inspect successful observations");
      },
    },
  );
  assert.equal(
    withCLIResultDiagnostics(() => 42, "not-json", observations),
    42,
  );
  assert.equal(reads, 0);
  for (const optional of [undefined, {}, { phase: secret }]) {
    const failure = new AssertionError({ message: "original" });
    assert.throws(
      () =>
        withCLIResultDiagnostics(
          () => {
            throw failure;
          },
          "{}",
          optional,
        ),
      (caught) => caught === failure,
    );
    const suffix = failure.message.slice(
      "original\nCLI_RESULT_METADATA ".length,
    );
    assert.deepEqual(JSON.parse(suffix), { input: "invalid-shape" });
  }
});
