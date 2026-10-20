import { freezeServiceBinding } from "./environments.mjs";
import { snapshotPlan } from "./core.mjs";
export function versionPlan(previous, input, source = "manual", project) {
  if (project && Array.isArray(input.steps))
    input = {
      ...input,
      steps: input.steps.map((step) => {
        const oldStep = previous?.steps?.find(
          (item) => item.id && item.id === step.id,
        );
        const request =
          oldStep && !Object.hasOwn(step.request || {}, "serviceSnapshot")
            ? { ...step.request, serviceSnapshot: true }
            : step.request;
        return {
          ...step,
          request: freezeServiceBinding(
            project,
            {
              ...(request || {}),
              ...(oldStep && !Object.hasOwn(step.request || {}, "authSnapshot")
                ? { authSnapshot: true }
                : {}),
              ...(oldStep &&
              !Object.hasOwn(step.request || {}, "parametersSnapshot")
                ? { parametersSnapshot: true }
                : {}),
            },
            { includeSharedScripts: false },
          ),
        };
      }),
    };
  const next = snapshotPlan({
    ...input,
    statusPolicy:
      input.statusPolicy ??
      previous?.statusPolicy ??
      (previous ? "assertions" : "strict200"),
    source,
    updatedAt: new Date().toISOString(),
  });
  const old = previous ? snapshotPlan(previous) : {};
  if (
    previous &&
    [
      "name",
      "description",
      "environmentId",
      "statusPolicy",
      "functions",
      "steps",
    ].every(
      (field) => JSON.stringify(next[field]) === JSON.stringify(old[field]),
    )
  )
    return structuredClone(previous);
  const provenance = {
    fields: { ...(old.provenance?.fields || {}) },
    steps: {},
  };
  for (const field of ["name", "description", "environmentId", "statusPolicy"])
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
