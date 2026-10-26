import { publicProjectCommitOutcome } from "./project-commit-outcome.mjs";

export function recordSaveSuccess(recordId) {
  return { recordSaved: true, recordId, attemptedRecordId: recordId };
}

// A rejected save is not proof of rollback. Keep the attempted identity for
// reconciliation, but only acknowledge a saved record after storage confirms it.
export function recordSaveFailure(projectId, attemptedRecordId, error) {
  const projected = publicProjectCommitOutcome(error);
  // A different project's recovery failure says nothing about this record's
  // commit outcome. Do not leak its identity or misattribute its typed status.
  const outcome =
    projected.project_id === projectId
      ? projected
      : projected.project_ids?.includes(projectId)
        ? { ...projected, project_ids: [projectId] }
        : {};
  const code = outcome.code || "RECORD_SAVE_FAILED";
  return {
    recordSaved: false,
    recordId: null,
    attemptedRecordId,
    persistenceError:
      code === "PROJECT_COMMIT_UNCERTAIN"
        ? "项目提交结果不确定；恢复并读取现有记录核对，勿重新执行请求"
        : code === "PROJECT_RECOVERY_REQUIRED"
          ? "执行记录保存未确认；请先恢复现有项目并核对记录，勿重新执行请求"
          : "执行记录保存未确认；请检查存储并核对现有记录，勿重新执行请求",
    persistenceOutcome: {
      code,
      ...outcome,
      // Even a generic storage failure never makes replaying network effects safe.
      retry_safe: false,
    },
  };
}

// Deliberately contains no execution callback and never retries a network action.
export async function appendExecutionRecord(store, projectId, field, record) {
  try {
    await store.append(projectId, field, record);
    return recordSaveSuccess(record.id);
  } catch (error) {
    return recordSaveFailure(projectId, record.id, error);
  }
}
