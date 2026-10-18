import { snapshotPlan } from "./core.mjs";
export function versionPlan(previous, input, source = "manual") {
  const next = snapshotPlan({
    ...input,
    source,
    updatedAt: new Date().toISOString(),
  });
  const old = previous || {};
  if (
    previous &&
    ["name", "description", "environmentId", "functions", "steps"].every(
      (field) => JSON.stringify(next[field]) === JSON.stringify(old[field]),
    )
  )
    return structuredClone(previous);
  const provenance = {
    fields: { ...(old.provenance?.fields || {}) },
    steps: {},
  };
  for (const field of ["name", "description", "environmentId"])
    if (JSON.stringify(next[field]) !== JSON.stringify(old[field]))
      provenance.fields[field] = source;
  for (const step of next.steps) {
    const oldStep = (old.steps || []).find((item) => item.id === step.id);
    provenance.steps[step.id] =
      JSON.stringify(oldStep) !== JSON.stringify(step)
        ? source
        : old.provenance?.steps?.[step.id] || "manual";
  }
  next.provenance = provenance;
  return next;
}
