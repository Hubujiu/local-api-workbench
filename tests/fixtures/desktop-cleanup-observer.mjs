// Test-only observations: no timers, retries, process control or error payloads.
const stages = new Set([
  "application-kill",
  "application-close",
  "ntlm-close",
  "jwt-close-connections",
  "jwt-close",
  "watchdog-clear",
  "temporary-directory-remove",
]);
export function createDesktopCleanupObserver({
  now = () => performance.now(),
  report = (entry) =>
    console.error("DESKTOP_CLEANUP_STAGE", JSON.stringify(entry)),
} = {}) {
  const seen = new Set();
  const clock = () => {
    try {
      const value = now();
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  };
  const emit = (entry) => {
    try {
      report(entry);
    } catch {
      // Diagnostics must not interrupt the existing cleanup path.
    }
  };
  return (stage) => {
    if (!stages.has(stage) || seen.has(stage)) return () => {};
    seen.add(stage);
    const started = clock();
    let finished = false;
    emit({ stage, state: "begin" });
    return (state = "completed") => {
      if (finished) return;
      finished = true;
      emit({
        stage,
        state: state === "failed" ? "failed" : "completed",
        elapsedMs: Math.min(
          86400000,
          Math.max(0, Math.round(clock() - started)),
        ),
      });
    };
  };
}
