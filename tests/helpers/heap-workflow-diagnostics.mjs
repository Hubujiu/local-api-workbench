import assert from "node:assert/strict";
import { workerFailureMetadata } from "./worker-rejection-diagnostics.mjs";

// Test-only: retain the original OOM contract and report API result metadata only
// after an assertion fails. Never serialize request, response, variables or text.
export function assertHeapWorkflowOOM(result, phase) {
  try {
    assert.equal(result.outcome ?? result.status, "failed");
    assert.match(result.error, /out of memory/);
    assert.equal(result.scriptStage, "script");
    assert.equal(result.scriptDiagnostics.activityBudgetMs, 250);
  } catch (failure) {
    try {
      if (["PRE", "POST", "PLAN-PRE"].includes(phase)) {
        const suffix =
          `\nHEAP_WORKFLOW_PHASE ${phase}\nWORKER_REJECTION_METADATA ` +
          JSON.stringify(workerFailureMetadata(result));
        if (Buffer.byteLength(suffix, "utf8") <= 2048) {
          const message = Object.getOwnPropertyDescriptor(failure, "message");
          if (message && typeof message.value === "string" && message.writable)
            Object.defineProperty(failure, "message", {
              ...message,
              value: message.value + suffix,
            });
        }
      }
    } catch {
      // Observation must not replace or suppress the original failure.
    }
    throw failure;
  }
}
