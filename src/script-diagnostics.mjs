// Public diagnostic fields contain only known stages and bounded scalar counters.
// Never expose worker input, source text, arbitrary error properties or host paths.
export function scriptFailureDetails(error) {
  const stages = new Set([
    "starting",
    "loading-libraries",
    "loading-engine",
    "bootstrap",
    "compatibility",
    "script",
    "async-completion",
    "serialization",
    "total-deadline",
    "cancelled",
    "response-override",
    "sequence-budget",
    "sequence-output",
  ]);
  const result = {};
  if (stages.has(error.scriptStage)) result.scriptStage = error.scriptStage;
  if (typeof error.scriptScope === "string" && error.scriptScope.length <= 200)
    result.scriptScope = error.scriptScope;
  const diagnostics = {};
  const source = error.scriptDiagnostics || {};
  for (const [key, max] of Object.entries({
    activityBudgetMs: 250,
    fakerCalls: 1001,
    timerCount: 101,
    requestCount: 11,
  })) {
    const value = source[key];
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= max &&
      (key === "activityBudgetMs" || Number.isInteger(value))
    )
      diagnostics[key] = value;
  }
  const lastStage = error.lastWorkerStage ?? source.lastWorkerStage;
  if (stages.has(lastStage)) diagnostics.lastWorkerStage = lastStage;
  const elapsed = error.elapsedMs ?? source.elapsedMs;
  if (Number.isSafeInteger(elapsed) && elapsed >= 0)
    diagnostics.elapsedMs = elapsed;
  if (Object.keys(diagnostics).length) result.scriptDiagnostics = diagnostics;
  return result;
}
