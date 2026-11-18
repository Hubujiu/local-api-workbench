// Full product MSI: 18k files plus transactional old-product removal. This is a
// fixed wall-clock bound, never an idle timer extended by log activity.
export const MSI_OPERATION_TIMEOUT_MS = 420_000;
export function waitForMsiExit(
  child,
  label,
  timeoutMs = MSI_OPERATION_TIMEOUT_MS,
) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", exited);
      child.off("error", failed);
    };
    const exited = (code, signal) => {
      cleanup();
      resolve([code, signal]);
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      // Do not terminate msiexec/service, retry, uninstall, or clean up unknown state.
      child.unref();
      const error = new Error(
        `MSI ${label} timeout after ${timeoutMs} ms: service state uncertain; do not retry or clean up`,
      );
      error.code = "MSI_TIMEOUT";
      reject(error);
    }, timeoutMs);
    child.once("exit", exited);
    child.once("error", failed);
  });
}
