// The journal may already be applied or recoverable. Never blindly replay a mutation.
export class ProjectCommitUncertain extends Error {
  constructor(projectId, cause) {
    super("项目提交结果不确定；恢复并读取现有项目后再决定是否重试", { cause });
    this.name = "ProjectCommitUncertain";
    this.code = "PROJECT_COMMIT_UNCERTAIN";
    this.projectId = projectId;
  }
}
export class ProjectRecoveryRequired extends Error {
  constructor(projectIds) {
    super("存在尚未恢复或无法读取的项目；请先恢复现有项目，暂不创建新项目");
    this.code = "PROJECT_RECOVERY_REQUIRED";
    this.projectIds = projectIds
      .filter(
        (id) => typeof id === "string" && /^[a-zA-Z0-9-]{1,200}$/.test(id),
      )
      .slice(0, 100);
  }
}
export function publicProjectCommitOutcome(error) {
  if (error instanceof ProjectRecoveryRequired)
    return {
      code: error.code,
      project_ids: error.projectIds,
      retry_safe: false,
    };
  if (!(error instanceof ProjectCommitUncertain)) return {};
  return {
    code: error.code,
    project_id: error.projectId,
    commit_outcome: "unknown",
    retry_safe: false,
  };
}
