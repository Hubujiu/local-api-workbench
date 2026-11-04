import test from "node:test";
import assert from "node:assert/strict";
import { scriptFailureDetails } from "../src/script-diagnostics.mjs";
import {
  executionResultMetadata,
  EXECUTION_RESULT_PREFIX,
} from "./helpers/execution-result-diagnostics.mjs";
import {
  cliResultMetadata,
  withCLIResultDiagnostics,
} from "./helpers/cli-result-diagnostics.mjs";
import { workerFailureMetadata } from "./helpers/worker-rejection-diagnostics.mjs";
import {
  projectWorkerFailure,
  parseWorkerDiagnostic,
  WORKER_PREFIX,
  MAX_PACKET_BYTES,
} from "../scripts/core-worker-observations.mjs";
function maximum() {
  const e = {
    scriptStage: "bootstrap",
    lastWorkerStage: "serialization",
    activityOperation: "native-assertion-completion",
    elapsedMs: 60000,
    scriptDiagnostics: {
      activityBudgetMs: 250,
      fakerCalls: 1001,
      timerCount: 101,
      requestCount: 11,
      bootstrapOperation: "context-and-bindings",
      bootstrapElapsedMs: 60000,
      bootstrapOperationMs: 60000,
      bootstrapCPUUs: 60000000,
      bootstrapOperationCPUUs: 60000000,
    },
    activityMetrics: {},
    activityCPUTimeUs: {},
    compatibilityDiagnostics: { version: 1, operation: "compatibility-eval" },
  };
  for (const k of [
    "compatibility",
    "functionLibrary",
    "userScript",
    "microtask",
    "callback",
    "promiseState",
    "serialization",
  ]) {
    e.activityMetrics[k + "Ms"] = 60000;
    e.activityCPUTimeUs[k + "Us"] = 60000000;
  }
  e.activityMetrics.fakerLoadMs = 60000;
  for (const k of ["mockAsset", "mockInstall", "sourceBuild", "evaluation"]) {
    e.compatibilityDiagnostics[k + "Ms"] = 60000;
    e.compatibilityDiagnostics[k + "CPUUs"] = 60000000;
  }
  return e;
}
test("maximum legal worker metadata with compatibility breakdown fits unchanged 2KiB caps", (t) => {
  const e = maximum();
  const suffix =
    "\nWORKER_REJECTION_METADATA " + JSON.stringify(workerFailureMetadata(e));
  const packet = projectWorkerFailure(e);
  const line = WORKER_PREFIX + JSON.stringify(packet);
  assert.equal(MAX_PACKET_BYTES, 2048);
  assert(Buffer.byteLength(suffix) <= 2048);
  assert(Buffer.byteLength(line) <= MAX_PACKET_BYTES);
  const parsed = parseWorkerDiagnostic(line);
  assert(parsed);
  assert.deepEqual(
    JSON.parse(JSON.stringify(parsed)),
    JSON.parse(JSON.stringify(packet)),
  );
  assert.equal(
    parsed.workers[0].compatibilityDiagnostics.evaluationCPUUs,
    60000000,
  );
  t.diagnostic(
    JSON.stringify({
      suffixBytes: Buffer.byteLength(suffix),
      packetBytes: Buffer.byteLength(line),
    }),
  );
});
test("strict CI packet parser rejects extra private fields and invalid breakdown versions or operations", () => {
  for (const mutate of [
    (d) => (d.secret = "PRIVATE-MARKER"),
    (d) => (d.version = 0),
    (d) => (d.version = 2),
    (d) => (d.operation = "private-stage"),
    (d) => (d.evaluationMs = 60001),
    (d) => (d.evaluationCPUUs = -1),
  ]) {
    const packet = JSON.parse(JSON.stringify(projectWorkerFailure(maximum())));
    mutate(packet.workers[0].compatibilityDiagnostics);
    assert.equal(
      parseWorkerDiagnostic(WORKER_PREFIX + JSON.stringify(packet)),
      undefined,
    );
  }
});

test("maximum compatibility and host lifecycle observations fit unchanged CI caps", () => {
  const e = maximum();
  e.hostLifecycle = {
    version: 1,
    terminalKind: "error",
    finishReason: "total-deadline",
    exitCode: 255,
  };
  for (const k of [
    "spawnMs",
    "timerArmMs",
    "timerTargetMs",
    "onlineMs",
    "librariesMs",
    "engineMs",
    "bootstrapMs",
    "compatibilityMs",
    "scriptMs",
    "asyncMs",
    "serializationMs",
    "terminalMs",
    "timerFireMs",
    "finishMs",
    "terminateMs",
    "exitMs",
    "settleMs",
  ])
    e.hostLifecycle[k] = 60000;
  e.hostSequence = {
    version: 1,
    stageIndex: 33,
    completed: 33,
    elapsedMs: 60000,
    priorWorkerMs: 60000,
    priorSpawnMs: 60000,
    priorExitWaitMs: 60000,
  };
  const suffix =
    "\nWORKER_REJECTION_METADATA " + JSON.stringify(workerFailureMetadata(e));
  const packet = projectWorkerFailure(e),
    line = WORKER_PREFIX + JSON.stringify(packet);
  assert(Buffer.byteLength(suffix) <= 2048);
  assert(Buffer.byteLength(line) <= MAX_PACKET_BYTES);
  assert.deepEqual(
    JSON.parse(JSON.stringify(parseWorkerDiagnostic(line))),
    JSON.parse(JSON.stringify(packet)),
  );
  const details = scriptFailureDetails(e);
  const execution = executionResultMetadata({
    status: "failed",
    error: "fixture",
    ...details,
  });
  assert(
    Buffer.byteLength(EXECUTION_RESULT_PREFIX + JSON.stringify(execution)) <=
      2048,
  );
  assert.equal(execution.scriptDiagnostics.hostLifecycle.exitMs, 60000);
  const stdout = JSON.stringify({
    status: "failed",
    results: Array.from({ length: 4 }, () => ({
      status: "failed",
      ...details,
    })),
  });
  let annotated;
  try {
    withCLIResultDiagnostics(() => assert.fail("fixture"), stdout);
  } catch (error) {
    annotated = error.message;
  }
  const marker = "\nCLI_RESULT_METADATA ";
  const cliSuffix = annotated.slice(annotated.indexOf(marker));
  assert(Buffer.byteLength(cliSuffix) <= 4096);
  const cli = JSON.parse(cliSuffix.slice(marker.length));
  assert(cli.hostObservationsOmitted >= 1);
  assert.equal(Object.keys(cli.steps).length, 4);
  const bad = JSON.parse(JSON.stringify(packet));
  bad.workers[0].hostLifecycle.secret = "PRIVATE";
  assert.equal(
    parseWorkerDiagnostic(WORKER_PREFIX + JSON.stringify(bad)),
    undefined,
  );
});

test("optional host diagnostics never displace legacy failure steps that fit", () => {
  const diagnostics = {
    activityBudgetMs: 250,
    fakerCalls: 1001,
    timerCount: 101,
    requestCount: 11,
    lastWorkerStage: "serialization",
    activityOperation: "serialization",
    elapsedMs: 60000,
  };
  for (const phase of [
    "compatibility",
    "functionLibrary",
    "userScript",
    "microtask",
    "callback",
    "promiseState",
    "serialization",
  ]) {
    diagnostics[phase + "Ms"] = 60000;
    diagnostics[phase + "CPUUs"] = 60000000;
  }
  const results = Array.from({ length: 4 }, () => ({
    status: "failed",
    scriptStage: "total-deadline",
    scriptDiagnostics: { ...diagnostics },
  }));
  const baseline = cliResultMetadata(
    JSON.stringify({ status: "failed", results }),
  );
  const host = {
    version: 1,
    finishReason: "total-deadline",
    terminalKind: "error",
    exitCode: 255,
  };
  for (const phase of [
    "spawn",
    "timerArm",
    "timerTarget",
    "online",
    "libraries",
    "engine",
    "bootstrap",
    "compatibility",
    "script",
    "async",
    "serialization",
    "terminal",
    "timerFire",
    "finish",
    "terminate",
    "exit",
    "settle",
  ])
    host[phase + "Ms"] = 60000;
  for (const step of results) step.scriptDiagnostics.hostLifecycle = host;
  let message;
  try {
    withCLIResultDiagnostics(
      () => assert.fail("fixture"),
      JSON.stringify({ status: "failed", results }),
    );
  } catch (error) {
    message = error.message;
  }
  const marker = "\nCLI_RESULT_METADATA ",
    suffix = message.slice(message.indexOf(marker));
  assert(Buffer.byteLength(suffix) <= 4096);
  const observed = JSON.parse(suffix.slice(marker.length));
  assert.deepEqual(Object.keys(observed.steps), ["0", "1", "2", "3"]);
  assert.equal(observed.omittedCount, 0);
  assert(observed.hostObservationsOmitted >= 1);
  for (let index = 0; index < 4; index++) {
    const legacy = { ...observed.steps[index] };
    delete legacy.hostLifecycle;
    assert.deepEqual(legacy, JSON.parse(JSON.stringify(baseline.steps[index])));
  }
});
