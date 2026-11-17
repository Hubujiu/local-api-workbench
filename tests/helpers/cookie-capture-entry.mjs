// Test-only coordination: an HTTP timeout before capture must fail the capture
// fixture, not wait forever for a hook that can no longer be reached.
export function observeCaptureEntry({
  execute,
  controller,
  entered,
  lifecycle,
}) {
  let first = true;
  let stoppedBeforeCapture = false;
  return async (...args) => {
    if (stoppedBeforeCapture) {
      const error = new Error("Capture fixture stopped before capture");
      error.code = "ABORT_ERR";
      throw error;
    }
    if (!first) return execute(...args);
    first = false;
    try {
      const result = await execute(...args);
      lifecycle.firstOutcome = "returned";
      return result;
    } catch (error) {
      lifecycle.firstOutcome = "rejected";
      let code;
      try {
        if (error && typeof error === "object")
          code = Object.getOwnPropertyDescriptor(error, "code")?.value;
      } catch {
        // Diagnostic inspection must never replace the original failure.
      }
      lifecycle.firstErrorCode = ["ABORT_ERR", "REQUEST_TIMEOUT"].includes(code)
        ? code
        : "OTHER";
      throw error;
    } finally {
      lifecycle.firstExecutionSettled = true;
      if (!lifecycle.captureEntered) {
        stoppedBeforeCapture = true;
        // This happens before runPlan can continue to another real request.
        controller.abort();
        entered.resolve();
      }
    }
  };
}
