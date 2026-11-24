const MAX_RESULTS = 50;

// The owner route passes the canonical Store snapshot, never a client draft.
export function recentSavedDefinitions(project) {
  const tracker = project.requestDefinitionHistory;
  const tracked = new Map(
    (tracker?.projectId === project.id ? tracker.entries : [])
      .filter((entry) => !entry.retired)
      .map((entry) => [entry.requestId, entry]),
  );
  const rows = [];
  let untracked = 0;
  for (const request of project.requests) {
    if (request.deletedAt) continue;
    const entry = tracked.get(request.id);
    if (!entry) {
      untracked++;
      continue;
    }
    rows.push({
      requestId: request.id,
      name: request.name,
      method: request.method,
      version: entry.currentVersion,
      currentCreatedAt: entry.currentCreatedAt,
    });
  }
  rows.sort(
    (left, right) =>
      Date.parse(right.currentCreatedAt) - Date.parse(left.currentCreatedAt) ||
      left.requestId.localeCompare(right.requestId),
  );
  return {
    projectId: project.id,
    configRevision: project.configRevision ?? project.revision ?? 0,
    tracked: rows.length,
    untracked,
    rows: rows.slice(0, MAX_RESULTS),
  };
}
