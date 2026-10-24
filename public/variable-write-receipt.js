export function adoptVariableWrites(project, updated, receipt) {
  if (!receipt?.commits) return "none";
  const currentRevision = project.configRevision ?? project.revision;
  const nextRevision = updated.configRevision ?? updated.revision;
  if (
    currentRevision !== receipt.baseConfigRevision ||
    nextRevision !== receipt.baseConfigRevision + receipt.commits
  )
    return "conflict";
  const environment = project.environments.find(
    (item) => item.id === receipt.environmentId,
  );
  if (!environment) return "conflict";
  for (const change of receipt.changes) {
    if (
      !["globals", "environment"].includes(change.scope) ||
      ["__proto__", "prototype", "constructor"].includes(change.name)
    )
      return "conflict";
    const map =
      change.scope === "globals"
        ? project.globalVariables || {}
        : environment.variables;
    if (
      Object.hasOwn(map, change.name) !== change.before.exists ||
      JSON.stringify(map[change.name]) !== JSON.stringify(change.before.value)
    )
      return "conflict";
  }
  project.globalVariables ??= {};
  for (const change of receipt.changes) {
    const map =
      change.scope === "globals"
        ? project.globalVariables
        : environment.variables;
    if (change.after.exists)
      map[change.name] = structuredClone(change.after.value);
    else delete map[change.name];
  }
  project.revision = updated.revision;
  project.configRevision = updated.configRevision;
  project._diskFingerprint = updated._diskFingerprint;
  project.updatedAt = updated.updatedAt;
  return "applied";
}
