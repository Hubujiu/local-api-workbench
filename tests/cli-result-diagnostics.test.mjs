import assert, { AssertionError } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  cliResultMetadata,
  withCLIResultDiagnostics,
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

test("persisted bootstrap run retains substep counters without manufacturing missing CPU", () => {
  const run = fixture();
  const step = run.results[1];
  step.scriptStage = "bootstrap";
  Object.assign(step.scriptDiagnostics, {
    bootstrapOperation: "trusted-libraries",
    bootstrapElapsedMs: 60000,
    bootstrapOperationMs: 60000,
    bootstrapCPUUs: 60000000,
    bootstrapOperationCPUUs: 60000000,
    bootstrapSecret: secret,
  });
  const fields = cliResultMetadata(JSON.stringify(run)).steps[0]
    .scriptDiagnostics;
  for (const key of [
    "bootstrapOperation",
    "bootstrapElapsedMs",
    "bootstrapOperationMs",
    "bootstrapCPUUs",
    "bootstrapOperationCPUUs",
  ])
    assert.equal(fields[key], step.scriptDiagnostics[key]);
  assert(!JSON.stringify(fields).includes(secret));
  delete step.scriptDiagnostics.bootstrapCPUUs;
  delete step.scriptDiagnostics.bootstrapOperationCPUUs;
  const partial = cliResultMetadata(JSON.stringify(run)).steps[0]
    .scriptDiagnostics;
  assert(!Object.hasOwn(partial, "bootstrapCPUUs"));
  assert(!Object.hasOwn(partial, "bootstrapOperationCPUUs"));
  for (const stage of ["script", "compatibility", "starting", undefined]) {
    step.scriptStage = stage;
    assert(
      !Object.hasOwn(
        cliResultMetadata(JSON.stringify(run)).steps[0].scriptDiagnostics,
        "bootstrapOperation",
      ),
    );
  }
});

test("persisted bootstrap counters reject unsafe values and keep maximum suffix bounded", () => {
  const run = fixture();
  const step = run.results[1];
  step.scriptStage = "bootstrap";
  step.scriptDiagnostics = { bootstrapOperation: "setup" };
  for (const [key, max] of Object.entries({
    bootstrapElapsedMs: 60000,
    bootstrapOperationMs: 60000,
    bootstrapCPUUs: 60000000,
    bootstrapOperationCPUUs: 60000000,
  })) {
    for (const value of [
      NaN,
      Infinity,
      -Infinity,
      -1,
      0.5,
      max + 1,
      "1",
      {},
      null,
    ]) {
      step.scriptDiagnostics[key] = value;
      assert(
        !Object.hasOwn(
          cliResultMetadata(JSON.stringify(run)).steps[0].scriptDiagnostics,
          key,
        ),
      );
    }
    step.scriptDiagnostics[key] = max;
  }
  for (const phase of [
    "compatibility",
    "functionLibrary",
    "userScript",
    "microtask",
    "callback",
    "promiseState",
    "serialization",
  ]) {
    step.scriptDiagnostics[phase + "Ms"] = 60000;
    step.scriptDiagnostics[phase + "CPUUs"] = 60000000;
  }
  Object.assign(step.scriptDiagnostics, {
    activityBudgetMs: 250,
    fakerCalls: 1001,
    timerCount: 101,
    requestCount: 11,
    fakerLoadMs: 60000,
    elapsedMs: 60000,
    lastWorkerStage: "bootstrap",
    activityOperation: "bootstrap",
    secret,
  });
  run.results = Array.from({ length: 5 }, () => step);
  const failure = new AssertionError({ message: "original" });
  assert.throws(
    () =>
      withCLIResultDiagnostics(() => {
        throw failure;
      }, JSON.stringify(run)),
    (error) => error === failure,
  );
  const suffix = failure.message.slice("original".length);
  assert(Buffer.byteLength(suffix) <= 4096);
  assert.match(suffix, /CLI_RESULT_METADATA/);
  assert(!suffix.includes(secret));
  step.scriptDiagnostics.bootstrapOperation = secret;
  assert(
    !Object.hasOwn(
      cliResultMetadata(JSON.stringify(run)).steps[0].scriptDiagnostics,
      "bootstrapOperation",
    ),
  );
});
