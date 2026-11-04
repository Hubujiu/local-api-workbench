import test from "node:test";
import assert from "node:assert/strict";
import {
  observeCompatibility,
  sanitizeCompatibilityDiagnostics,
} from "../src/script-compat-diagnostics.mjs";
import { scriptFailureDetails } from "../src/script-diagnostics.mjs";
import { runScript } from "../src/scripts.mjs";
import { workerFailureMetadata } from "./helpers/worker-rejection-diagnostics.mjs";
import { projectWorkerFailure } from "../scripts/core-worker-observations.mjs";
import { executionResultMetadata } from "./helpers/execution-result-diagnostics.mjs";

test("observer measures completed phases and the last phase even on errors", () => {
  let time = 10,
    micros = 100;
  const observer = observeCompatibility(
    () => time,
    () => ({ user: micros, system: 0 }),
  );
  observer.enter("mock-asset");
  time += 4;
  micros += 1000;
  observer.leave();
  observer.enter("compatibility-eval");
  time += 7;
  micros += 3000;
  observer.leave();
  assert.deepEqual(observer.snapshot(), {
    version: 1,
    operation: "compatibility-eval",
    mockAssetMs: 4,
    mockAssetCPUUs: 1000,
    evaluationMs: 7,
    evaluationCPUUs: 3000,
  });
});

test("invalid CPU values are omitted and diagnostic errors never replace execution", () => {
  let time = 10;
  const observer = observeCompatibility(
    () => time,
    () => {
      throw Error("hidden");
    },
  );
  observer.enter("mock-install");
  time += 2;
  observer.leave();
  assert.deepEqual(observer.snapshot(), {
    version: 1,
    operation: "mock-install",
    mockInstallMs: 2,
  });
  const broken = observeCompatibility(
    () => {
      throw Error("hidden");
    },
    () => null,
  );
  assert.doesNotThrow(() => {
    broken.enter("mock-asset");
    broken.leave();
  });
  assert.equal(broken.snapshot(), undefined);
});

test("projection rejects proxies and accessors without invoking them", () => {
  let calls = 0;
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        calls++;
        throw Error("trap");
      },
    },
  );
  assert.equal(sanitizeCompatibilityDiagnostics(hostile), undefined);
  const error = {};
  Object.defineProperty(error, "compatibilityDiagnostics", {
    get() {
      calls++;
      throw Error("getter");
    },
  });
  assert.deepEqual(scriptFailureDetails(error), {});
  assert.equal(calls, 0);
  const data = {
    version: 1,
    operation: "mock-install",
    mockInstallMs: 5,
    secret: "never",
    evaluationMs: Infinity,
  };
  const projected = scriptFailureDetails({ compatibilityDiagnostics: data });
  assert.deepEqual(projected.scriptDiagnostics, {
    compatibilityOperation: "mock-install",
    compatMockInstallMs: 5,
  });
  assert(!JSON.stringify(projected).includes("never"));
});

test("failure diagnostics carry bounded breakdown through runtime and test projections", async () => {
  let caught;
  try {
    await runScript('throw Error("diagnostic-fixture")', {
      request: {},
      response: { status: 200, body: "ok" },
      variables: {},
    });
  } catch (error) {
    caught = error;
  }
  assert(caught);
  assert.match(caught.message, /diagnostic-fixture/);
  const raw = workerFailureMetadata(caught);
  assert.equal(raw.compatibilityDiagnostics.version, 1);
  assert.equal(raw.compatibilityDiagnostics.operation, "compatibility-eval");
  assert(Number.isSafeInteger(raw.compatibilityDiagnostics.mockInstallMs));
  const publicResult = scriptFailureDetails(caught);
  assert.equal(
    publicResult.scriptDiagnostics.compatibilityOperation,
    "compatibility-eval",
  );
  const projected = executionResultMetadata({
    status: "failed",
    error: caught.message,
    ...publicResult,
  });
  assert.equal(
    projected.scriptDiagnostics.compatibilityOperation,
    "compatibility-eval",
  );
  assert(Buffer.byteLength(JSON.stringify(raw)) < 2048);
  const packet = projectWorkerFailure(caught);
  assert.equal(packet.availability, "observed");
  assert.equal(
    packet.workers[0].compatibilityDiagnostics.operation,
    "compatibility-eval",
  );
  assert(Buffer.byteLength(JSON.stringify(packet)) < 2048);
});
