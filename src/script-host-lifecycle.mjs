import { types } from "node:util";
const fields = new Set([
  "spawnMs",
  "timerArmMs",
  "timerTargetMs",
  "onlineMs",
  "librariesMs",
  "engineMs",
  "bootstrapMs",
  "compatibilityMs",
  "scriptMs",
  "asyncMs",
  "serializationMs",
  "terminalMs",
  "timerFireMs",
  "finishMs",
  "terminateMs",
  "exitMs",
  "settleMs",
]);
const stages = {
  "loading-libraries": "librariesMs",
  "loading-engine": "engineMs",
  bootstrap: "bootstrapMs",
  compatibility: "compatibilityMs",
  script: "scriptMs",
  "async-completion": "asyncMs",
  serialization: "serializationMs",
};
const reasons = new Set([
  "total-deadline",
  "cancelled",
  "worker-error",
  "worker-exit",
  "host-error",
]);
const own = (value, key) => {
  if (!value || typeof value !== "object" || types.isProxy(value)) return;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && Object.hasOwn(d, "value") ? d.value : undefined;
};
const valid = (value, max = 60000) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max;
export function observeHostLifecycle(now) {
  let origin;
  try {
    origin = now();
  } catch {
    return {
      mark() {},
      stage() {},
      dueAt() {},
      terminal() {},
      finish() {},
      exit() {},
      snapshot() {
        return undefined;
      },
    };
  }
  const out = { version: 1 };
  const current = () => {
    try {
      const n = Math.round(now() - origin);
      return valid(n) ? n : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    mark(name) {
      if (!fields.has(name) || Object.hasOwn(out, name)) return;
      const n = current();
      if (n !== undefined) out[name] = n;
    },
    stage(name) {
      if (typeof name === "string" && Object.hasOwn(stages, name))
        this.mark(stages[name]);
    },
    // Estimate from the existing host start sample; this is not Node's
    // internal timer deadline and never participates in timeout decisions.
    dueAt(absolute) {
      if (Number.isFinite(absolute) && Number.isFinite(origin)) {
        const target = Math.round(absolute - origin);
        if (valid(target)) out.timerTargetMs = target;
      }
    },
    terminal(kind) {
      if (
        ["result", "error"].includes(kind) &&
        !Object.hasOwn(out, "terminalKind")
      )
        out.terminalKind = kind;
      this.mark("terminalMs");
    },
    finish(reason) {
      if (reasons.has(reason) && !Object.hasOwn(out, "finishReason"))
        out.finishReason = reason;
      this.mark("finishMs");
    },
    exit(code) {
      this.mark("exitMs");
      if (valid(code, 255)) out.exitCode = code;
    },
    snapshot() {
      return { ...out };
    },
  };
}
export function sanitizeHostLifecycle(value) {
  if (own(value, "version") !== 1) return;
  const out = { version: 1 };
  for (const key of fields) {
    const n = own(value, key);
    if (valid(n)) out[key] = n;
  }
  const code = own(value, "exitCode");
  if (valid(code, 255)) out.exitCode = code;
  const terminal = own(value, "terminalKind");
  if (["result", "error"].includes(terminal)) out.terminalKind = terminal;
  const reason = own(value, "finishReason");
  if (reasons.has(reason)) out.finishReason = reason;
  return out;
}
export function sanitizeHostSequence(value) {
  if (own(value, "version") !== 1) return;
  const out = { version: 1 };
  for (const key of ["stageIndex", "completed"]) {
    const n = own(value, key);
    if (valid(n, 34)) out[key] = n;
  }
  for (const key of [
    "elapsedMs",
    "priorWorkerMs",
    "priorSpawnMs",
    "priorExitWaitMs",
  ]) {
    const n = own(value, key);
    if (valid(n)) out[key] = n;
  }
  return out;
}
export function readHostDiagnostics(error, key) {
  return key === "hostLifecycle"
    ? sanitizeHostLifecycle(own(error, key))
    : key === "hostSequence"
      ? sanitizeHostSequence(own(error, key))
      : undefined;
}
