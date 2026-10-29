import { ProjectCommitUncertain } from "./project-commit-outcome.mjs";

// Owner project PUT only. Store distinguishes definite rejection from a
// journaled/recoverable write; a failed acknowledgement is not a rollback.
export async function saveProjectArchive(project, save, revoke) {
  const archived = Boolean(project.archived),
    projectId = project.id;
  let saved;
  try {
    saved = await save();
  } catch (error) {
    if (
      archived &&
      error instanceof ProjectCommitUncertain &&
      error.projectId === projectId
    ) {
      // Preserve the existing conservative in-memory revocation on uncertainty.
      // Never replace its primary typed outcome or retry the project write.
      try {
        revoke(projectId);
      } finally {
        throw error;
      }
    }
    throw error;
  }
  if (archived) revoke(projectId);
  return saved;
}
