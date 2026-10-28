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
    "let deadline = Date.now() + 1000;",
    "runtime.setInterruptHandler(() => Date.now() > deadline);",
    "deadline = Date.now() + workerData.activityBudgetMs;",
  ])
    assert(worker.includes(literal));
  assert(scripts.includes("activityBudgetMs = 250"));
  assert(scripts.includes("wallBudgetMs = 2000"));
  const start = worker.indexOf("bootstrapObservation = observeBootstrap");
  assert(start > worker.indexOf("let deadline = Date.now() + 1000;"));
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
