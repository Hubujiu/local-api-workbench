import { AssertionError } from "node:assert";
import { workerFailureMetadata } from "./worker-rejection-diagnostics.mjs";

// Test-only fixed-case, bounded whitelist. Never emit task source or errors.
export async function diagnoseHeaderCompletion(caseIndex, assertion, emit) {
  let rejection;
  try {
    await assertion((error) => {
      rejection = error;
      throw error;
    });
  } catch (failure) {
    if (failure instanceof AssertionError && [0, 1, 2].includes(caseIndex)) {
      const line =
        "HEADER_COMPLETION_DIAGNOSTIC " +
        JSON.stringify({
          version: 1,
          caseIndex,
          worker: workerFailureMetadata(rejection),
        });
      if (Buffer.byteLength(line) <= 2304) {
        try {
          emit(line);
        } catch {
          /* Diagnostics cannot replace the failure. */
        }
      }
    }
    throw failure;
  }
}
