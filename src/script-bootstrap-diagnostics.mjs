// Failure-only observations, never admission, interruption or billing inputs.
// Elapsed starts after the existing bootstrap interrupt deadline is installed,
// before context creation. It excludes bundle/engine loading and active scripts.
// The operation is the interrupted/current substep, not proof it caused delay.
// Missing CPU means unavailable; out-of-range counters are omitted, not clamped.
const operations = new Set([
  "context-and-bindings",
  "input-transfer",
  "setup",
  "url-tools",
  "trusted-libraries",
  "optional-facade",
  "lazy-installers",
]);
export function bootstrapFailureDetails(source = {}) {
  const result = {};
  if (!operations.has(source.bootstrapOperation)) return result;
  result.bootstrapOperation = source.bootstrapOperation;
  for (const [key, max] of Object.entries({
    bootstrapElapsedMs: 60000,
    bootstrapOperationMs: 60000,
    bootstrapCPUUs: 60000000,
    bootstrapOperationCPUUs: 60000000,
  })) {
    const value = source[key];
    if (Number.isSafeInteger(value) && value >= 0 && value <= max)
      result[key] = value;
  }
  return result;
}

export function observeBootstrap(now, cpu) {
  const started = now(),
    cpuStarted = cpu();
  let operation = "context-and-bindings",
    operationStarted = started,
    operationCPUStarted = cpuStarted;
  const cpuDelta = (start, end) =>
    start && end
      ? Math.max(0, end.user + end.system - start.user - start.system)
      : undefined;
  return {
    enter(next) {
      if (!operations.has(next)) return;
      operation = next;
      operationStarted = now();
      operationCPUStarted = cpu();
    },
    failure() {
      const finished = now(),
        cpuFinished = cpu();
      return bootstrapFailureDetails({
        bootstrapOperation: operation,
        bootstrapElapsedMs: Math.round(Math.max(0, finished - started)),
        bootstrapOperationMs: Math.round(
          Math.max(0, finished - operationStarted),
        ),
        bootstrapCPUUs: cpuDelta(cpuStarted, cpuFinished),
        bootstrapOperationCPUUs: cpuDelta(operationCPUStarted, cpuFinished),
      });
    },
  };
}
