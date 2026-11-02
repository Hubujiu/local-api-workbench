import { types } from "node:util";

// A lossy diagnostic channel, never a completion receipt. No stage is success.
export const sqliteOperationMessageLimit = 16;
const successors = Object.freeze({
  start: ["validate"],
  validate: ["probe-open"],
  "probe-open": ["probe-close"],
  "probe-close": ["write-open"],
  "write-open": ["begin"],
  begin: ["prepare", "rollback"],
  prepare: ["step", "rollback"],
  step: ["changes", "rollback"],
  changes: ["commit", "rollback"],
  commit: ["commit-complete", "rollback"],
  "commit-complete": ["close"],
  rollback: ["close"],
  close: ["close-complete"],
  "close-complete": [],
});
const stages = new Set(
  Object.keys(successors).filter((key) => key !== "start"),
);
const milliseconds = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 86400000;

function canFollow(previous, next) {
  // IPC can lose intermediate observations. Accept only a forward subsequence
  // of the fixed acyclic operation graph, including its rollback branch.
  return successors[previous].some(
    (stage) => stage === next || canFollow(stage, next),
  );
}

export function sqliteOperationDetails(stage, elapsedMs) {
  return typeof stage === "string" &&
    stages.has(stage) &&
    milliseconds(elapsedMs)
    ? { operationStage: stage, operationElapsedMs: elapsedMs }
    : {};
}

function ownValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

export function createSQLiteOperationTracker() {
  let attempts = 0,
    previous = "start",
    elapsed = 0;
  return (value) => {
    // Count invalid traffic too. Every layer has its own bounded observation
    // budget; exhausting it only loses diagnostics, never changes execution.
    if (attempts >= sqliteOperationMessageLimit) return null;
    attempts++;
    try {
      if (!value || typeof value !== "object" || types.isProxy(value))
        return null;
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== 3 ||
        !keys.every((key) => ["kind", "stage", "elapsedMs"].includes(key))
      )
        return null;
      const kind = ownValue(value, "kind"),
        stage = ownValue(value, "stage"),
        elapsedMs = ownValue(value, "elapsedMs");
      if (
        kind !== "sqlite-operation-stage" ||
        !Object.hasOwn(
          sqliteOperationDetails(stage, elapsedMs),
          "operationStage",
        ) ||
        elapsedMs < elapsed ||
        !canFollow(previous, stage)
      )
        return null;
      previous = stage;
      elapsed = elapsedMs;
      return { kind: "sqlite-operation-stage", stage, elapsedMs };
    } catch {
      return null;
    }
  };
}
