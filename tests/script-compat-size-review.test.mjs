import test from "node:test";
import assert from "node:assert/strict";
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
