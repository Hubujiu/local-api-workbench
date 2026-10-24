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
  const metrics = error.activityMetrics || {};
  for (const [key, max] of Object.entries({
    activityBudgetMs: 250,
    fakerCalls: 1001,
    timerCount: 101,
    requestCount: 11,
    compatibilityMs: 60000,
    fakerLoadMs: 60000,
    functionLibraryMs: 60000,
    userScriptMs: 60000,
    microtaskMs: 60000,
    callbackMs: 60000,
    promiseStateMs: 60000,
    serializationMs: 60000,
  })) {
    const value =
      key.endsWith("Ms") && key !== "activityBudgetMs"
        ? (metrics[key] ?? source[key])
        : source[key];
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= max &&
      (key === "activityBudgetMs" || Number.isInteger(value))
    )
      diagnostics[key] = value;
  }
  if (
    [
      "bootstrap",
      "compatibility",
      "function-library",
      "user-script",
      "microtasks",
      "promise-state",
      "pending-tasks",
      "http-callback",
      "timer-callback",
      "serialization",
    ].includes(error.activityOperation ?? source.activityOperation)
  )
    diagnostics.activityOperation =
      error.activityOperation ?? source.activityOperation;
  const lastStage = error.lastWorkerStage ?? source.lastWorkerStage;
  if (stages.has(lastStage)) diagnostics.lastWorkerStage = lastStage;
  const elapsed = error.elapsedMs ?? source.elapsedMs;
  if (Number.isSafeInteger(elapsed) && elapsed >= 0)
    diagnostics.elapsedMs = elapsed;
  if (Object.keys(diagnostics).length) result.scriptDiagnostics = diagnostics;
  if (Array.isArray(error.sequenceActivity)) {
    result.sequenceActivity = error.sequenceActivity
      .slice(0, 34)
      .flatMap((entry) => {
        if (
          !entry ||
          typeof entry !== "object" ||
          !Number.isInteger(entry.stageIndex) ||
          entry.stageIndex < 0 ||
          entry.stageIndex > 33
        )
          return [];
        const counters =
          scriptFailureDetails({
            scriptDiagnostics: {
              activityBudgetMs: entry.activityBudgetMs,
              fakerCalls: entry.fakerCalls,
              timerCount: entry.timerCount,
              requestCount: entry.requestCount,
            },
            activityMetrics: entry.activityMetrics,
          }).scriptDiagnostics || {};
        const row = { stageIndex: entry.stageIndex, ...counters };
        for (const key of ["activityMs", "elapsedMs"]) {
          const value = entry[key];
          if (
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= 0 &&
            value <= 60000
          )
            row[key] = value;
        }
        return [row];
      });
  }
  return result;
}
