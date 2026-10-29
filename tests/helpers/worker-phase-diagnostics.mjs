import { isProxy } from "node:util/types";
import { workerFailureMetadata } from "./worker-rejection-diagnostics.mjs";

// Test-only observation. Callers pass static labels and retain their original
// assertions; capture rethrows the untouched worker rejection before matching.
export async function withWorkerPhaseDiagnostics(label, workload) {
  let rejection;
  try {
    return await workload((error) => {
      rejection = error;
      throw error;
    });
  } catch (failure) {
    // Observe only an unexpected failure, after the original assertion ran.
    // Diagnostic failures must never replace the original thrown object.
    try {
      if (
        typeof label === "string" &&
        /^[a-z][a-z0-9-]{0,63}$/.test(label) &&
        !isProxy(failure) &&
        failure instanceof Error
      ) {
        const message = Object.getOwnPropertyDescriptor(failure, "message");
        if (message && typeof message.value === "string" && message.writable) {
          const suffix =
            `\nWORKER_PHASE ${label}\nWORKER_REJECTION_METADATA ` +
            JSON.stringify(workerFailureMetadata(rejection ?? failure));
          if (Buffer.byteLength(suffix, "utf8") <= 2048)
            Object.defineProperty(failure, "message", {
              ...message,
              value: message.value + suffix,
            });
        }
      }
    } catch {
      // Observation is best effort; the existing failure still fails below.
    }
    throw failure;
  }
}
