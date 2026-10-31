import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  observeBootstrap,
  bootstrapFailureDetails,
} from "../src/script-bootstrap-diagnostics.mjs";
import { scriptFailureDetails } from "../src/script-diagnostics.mjs";

test("bootstrap failure observations retain the current substep and independent wall/CPU time", () => {
  let wall = 100,
    cpu = { user: 20, system: 10 };
  const observation = observeBootstrap(
    () => wall,
    () => cpu,
  );
  wall = 150;
  cpu = { user: 30, system: 15 };
  observation.enter("trusted-libraries");
  wall = 1200;
  cpu = { user: 60, system: 20 };
  const fields = observation.failure();
  assert.deepEqual(fields, {
    bootstrapOperation: "trusted-libraries",
    bootstrapElapsedMs: 1100,
    bootstrapOperationMs: 1050,
    bootstrapCPUUs: 50,
    bootstrapOperationCPUUs: 35,
  });
  // Existing scripts.mjs transports scriptDiagnostics unchanged from the worker.
  const transported = JSON.parse(
    JSON.stringify({
      scriptStage: "bootstrap",
      scriptDiagnostics: { ...fields, activityBudgetMs: 250 },
    }),
  );
  assert.deepEqual(scriptFailureDetails(transported), transported);
  assert.equal(transported.scriptDiagnostics.activityBudgetMs, 250);
});

test("unavailable CPU is absent, not zero; first context failure and clock rollback stay bounded", () => {
  let wall = 100;
  const observation = observeBootstrap(
    () => wall,
    () => null,
  );
  wall = 90;
  observation.enter("https://secret.invalid/token");
  assert.deepEqual(observation.failure(), {
    bootstrapOperation: "context-and-bindings",
    bootstrapElapsedMs: 0,
    bootstrapOperationMs: 0,
  });
});

test("only enumerated bootstrap operations and bounded integer counters enter failure records", () => {
  const names = [
    "context-and-bindings",
    "input-transfer",
    "setup",
    "url-tools",
    "trusted-libraries",
    "optional-facade",
    "lazy-installers",
  ];
  for (const bootstrapOperation of names) {
    const source = {
      bootstrapOperation,
      bootstrapElapsedMs: 60000,
      bootstrapOperationMs: 0,
      bootstrapCPUUs: 60000000,
      bootstrapOperationCPUUs: 0,
    };
    assert.deepEqual(
      bootstrapFailureDetails({
        ...source,
        input: "secret",
        code: "secret",
        url: "secret",
        credentials: "secret",
      }),
      source,
    );
    for (const invalid of [-1, 0.5, Infinity, NaN, "1", {}, 60000001]) {
      assert.deepEqual(
        bootstrapFailureDetails({
          bootstrapOperation,
          bootstrapElapsedMs: invalid,
          bootstrapOperationMs: invalid,
          bootstrapCPUUs: invalid,
          bootstrapOperationCPUUs: invalid,
        }),
        { bootstrapOperation },
      );
    }
    assert.deepEqual(
      bootstrapFailureDetails({
        bootstrapOperation,
        bootstrapElapsedMs: 60001,
        bootstrapOperationMs: 60001,
      }),
      { bootstrapOperation },
    );
  }
  assert.deepEqual(
    bootstrapFailureDetails({
      bootstrapOperation: "private",
      bootstrapElapsedMs: 2,
    }),
    {},
  );
  assert.deepEqual(
    scriptFailureDetails({
      scriptStage: "script",
      scriptDiagnostics: { bootstrapOperation: "setup", bootstrapElapsedMs: 1 },
    }),
    { scriptStage: "script" },
  );
  assert.deepEqual(
    scriptFailureDetails({
      scriptStage: "bootstrap",
      scriptDiagnostics: {
        bootstrapOperation: "private",
        bootstrapElapsedMs: 1,
      },
    }),
    { scriptStage: "bootstrap" },
  );
});

test("source wiring keeps bootstrap deadline and resource limits, with failure-only observation", async () => {
  const worker = await readFile(
    new URL("../src/script-worker.mjs", import.meta.url),
    "utf8",
  );
  const scripts = await readFile(
    new URL("../src/scripts.mjs", import.meta.url),
    "utf8",
  );
  for (const literal of [
    "runtime.setMemoryLimit(16 * 1024 * 1024);",
    "runtime.setMaxStackSize(512 * 1024);",
    "let deadline = monotonicNow() + 1000;",
    "runtime.setInterruptHandler(() => monotonicNow() > deadline);",
    "deadline = monotonicNow() + workerData.activityBudgetMs;",
  ])
    assert(worker.includes(literal));
  assert(scripts.includes("activityBudgetMs = 250"));
  assert(scripts.includes("wallBudgetMs = 2000"));
  const start = worker.indexOf("bootstrapObservation = observeBootstrap");
  assert(start > worker.indexOf("let deadline = monotonicNow() + 1000;"));
  assert(start < worker.indexOf("context = runtime.newContext();"));
  assert(
    worker.indexOf('bootstrapObservation.enter("setup")') <
      worker.indexOf("run(setup);"),
  );
  assert(
    worker.indexOf("run(trustedLibraries);") <
      worker.indexOf('scriptStage = "compatibility";'),
  );
  const successStart = worker.indexOf("...serializedResult");
  const failureStart = worker.indexOf("} catch (error) {", successStart);
  assert(
    !worker.slice(successStart, failureStart).includes("bootstrapObservation"),
  );
  assert.equal(
    (worker.match(/bootstrapObservation\?\.failure\(\)/g) || []).length,
    1,
  );
  assert(worker.slice(failureStart).includes('scriptStage === "bootstrap"'));
});

test("fractional monotonic observations round only diagnostic totals", () => {
  let elapsed = 100.125;
  const observation = observeBootstrap(
    () => elapsed,
    () => null,
  );
  elapsed = 100.375;
  observation.enter("setup");
  elapsed = 100.875;
  const fields = observation.failure();
  assert.deepEqual(fields, {
    bootstrapOperation: "setup",
    bootstrapElapsedMs: 1,
    bootstrapOperationMs: 1,
  });
  assert.deepEqual(
    scriptFailureDetails({
      scriptStage: "bootstrap",
      scriptDiagnostics: fields,
    }),
    { scriptStage: "bootstrap", scriptDiagnostics: fields },
  );
  // The observer's starting points remain fractional after an emitted snapshot.
  elapsed = 101.5;
  assert.deepEqual(observation.failure(), {
    bootstrapOperation: "setup",
    bootstrapElapsedMs: 1,
    bootstrapOperationMs: 1,
  });
});

test("host monotonic wiring preserves guest timestamps and unrounded activity enforcement", async () => {
  const worker = await readFile(
    new URL("../src/script-worker.mjs", import.meta.url),
    "utf8",
  );
  for (const literal of [
    'import { performance } from "node:perf_hooks";',
    "const monotonicNow = performance.now.bind(performance);",
    "bootstrapObservation = observeBootstrap(monotonicNow, threadCPU);",
    "due: monotonicNow() + milliseconds,",
    "earliest > monotonicNow()",
    "Math.max(0, earliest - monotonicNow())",
    "const now = monotonicNow();",
    "let remaining = deadline - monotonicNow();",
    'if (remaining <= 0) throw Error("脚本执行超时");',
    "const start = monotonicNow();",
    "deadline = start + remaining;",
    "remaining -= monotonicNow() - start;",
    "const serializationStart = monotonicNow();",
    "deadline = serializationStart + Math.max(0, remaining);",
    "if (outcome.result.activityMs > workerData.activityBudgetMs)",
    "activityMetrics[metric] += Math.max(0, monotonicNow() - started);",
    "Object.entries(activityMetrics).map",
    "Math.round(value)",
    "()=>Date.now(),__fakerVariable",
  ])
    assert(worker.includes(literal), literal);
  // Only generated guest code reads civil time; comments are not executable.
  const civilReads = worker
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .filter((line) => line.includes("Date.now"));
  assert.equal(civilReads.length, 1);
  assert(civilReads[0].includes("const builtinVariable="));
  assert.equal(
    (worker.match(/\.\.\.readActivityMetrics\(\)/g) || []).length,
    2,
  );
  const charge = worker.slice(
    worker.indexOf("activityMs:\n"),
    worker.indexOf("// Native JSON/string conversion"),
  );
  assert.match(
    charge,
    /workerData\.activityBudgetMs\s*-\s*remaining\s*\+\s*monotonicNow\(\)\s*-\s*serializationStart/,
  );
  assert(!charge.includes("Math.round"));
});
