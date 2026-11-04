import { types } from "node:util";

const phases = [
  "mock-asset",
  "mock-install",
  "source-build",
  "compatibility-eval",
];
const fields = {
  "mock-asset": "mockAsset",
  "mock-install": "mockInstall",
  "source-build": "sourceBuild",
  "compatibility-eval": "evaluation",
};
const own = (value, key) => {
  if (!value || typeof value !== "object" || types.isProxy(value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
};
const valid = (value, max) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max;

// Diagnostic observer only: callers retain all existing activity/deadline logic.
export function observeCompatibility(now, cpu) {
  let active, last;
  const values = Object.create(null);
  const cpuTime = () => {
    try {
      const value = cpu?.();
      return value &&
        Number.isFinite(value.user) &&
        Number.isFinite(value.system)
        ? value.user + value.system
        : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    enter(phase) {
      if (!phases.includes(phase) || active) return;
      try {
        active = { phase, started: now(), cpu: cpuTime() };
        last = phase;
      } catch {
        active = undefined;
      }
    },
    leave() {
      if (!active) return;
      const entry = active;
      active = undefined;
      try {
        const elapsed = Math.round(Math.max(0, now() - entry.started));
        if (valid(elapsed, 60000)) values[fields[entry.phase] + "Ms"] = elapsed;
        const ended = cpuTime();
        if (ended !== undefined && entry.cpu !== undefined) {
          const used = Math.round(Math.max(0, ended - entry.cpu));
          if (valid(used, 60000000))
            values[fields[entry.phase] + "CPUUs"] = used;
        }
      } catch {
        /* diagnostics never replace the original error */
      }
    },
    snapshot() {
      if (!last) return undefined;
      return { version: 1, operation: last, ...values };
    },
  };
}

// Project only explicit own data properties, never getters/proxy traps.
export function sanitizeCompatibilityDiagnostics(value) {
  const version = own(value, "version"),
    operation = own(value, "operation");
  if (version !== 1 || !phases.includes(operation)) return undefined;
  const out = { version: 1, operation };
  for (const prefix of Object.values(fields))
    for (const [suffix, max] of [
      ["Ms", 60000],
      ["CPUUs", 60000000],
    ]) {
      const key = prefix + suffix,
        candidate = own(value, key);
      if (valid(candidate, max)) out[key] = candidate;
    }
  return out;
}

export function readCompatibilityDiagnostics(error) {
  return sanitizeCompatibilityDiagnostics(
    own(error, "compatibilityDiagnostics"),
  );
}
