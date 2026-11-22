import { validateSavedVersionSummary } from "./recent-saved-versions.js";

const changed = () =>
  Error("已保存版本或项目已变化，未移到回收站；请重新进入或重新读取");

export function recentSavedTrashAvailable(
  project,
  receipt,
  { dirty, busy, saving },
) {
  return Boolean(
    project &&
      receipt?.projectId === project.id &&
      receipt.configRevision === (project.configRevision ?? project.revision) &&
      !project.archived &&
      !project.settings?.nativeInheritance &&
      !dirty &&
      !busy &&
      !saving,
  );
}

// Validate the whole selection before returning any mutable draft targets.
export function recentSavedTrashTargets(
  project,
  selectedIds,
  visible,
  latest,
  state,
) {
  validateSavedVersionSummary(visible, project.id);
  validateSavedVersionSummary(latest, project.id);
  if (
    !recentSavedTrashAvailable(project, visible, state) ||
    !recentSavedTrashAvailable(project, latest, state) ||
    !Array.isArray(selectedIds) ||
    !selectedIds.length ||
    selectedIds.length > visible.rows.length ||
    new Set(selectedIds).size !== selectedIds.length
  )
    throw changed();
  const displayed = new Map(visible.rows.map((row) => [row.requestId, row]));
  const persisted = new Map(latest.rows.map((row) => [row.requestId, row]));
  return selectedIds.map((id) => {
    const first = displayed.get(id),
      second = persisted.get(id),
      matches = project.requests.filter((entry) => entry.id === id),
      draft = matches[0];
    if (
      !first ||
      !second ||
      matches.length !== 1 ||
      draft.deletedAt ||
      first.version !== second.version ||
      first.currentCreatedAt !== second.currentCreatedAt ||
      first.name !== second.name ||
      first.method !== second.method ||
      draft.name !== second.name ||
      draft.method !== second.method
    )
      throw changed();
    return draft;
  });
}
