import {
  ProjectCommitUncertain,
  ProjectRecoveryRequired,
} from "./project-commit-outcome.mjs";

// Describes only this requested project's configuration commit. Earlier session
// deactivation/suspension may already have side effects, so never promise replay.
export function createOwnerProjectPutOutcome(projectId) {
  if (!/^[a-zA-Z0-9-]+$/.test(projectId)) return null;
  let outcome = "unknown";
  return {
    validatedRead() {
      outcome = "not_committed";
    },
    async save(saveProject) {
      outcome = "unknown";
      try {
        // Wrap Store.save itself: archive revocation can throw after it returns.
        return await saveProject();
      } catch (error) {
        // Store types every possible journal publication/readback/unlock failure.
        if (
          !(error instanceof ProjectCommitUncertain) &&
          !(error instanceof ProjectRecoveryRequired)
        )
          outcome = "not_committed";
        throw error;
      }
    },
    public(error) {
      return {
        project_id: projectId,
        commit_outcome:
          error instanceof ProjectCommitUncertain ||
          error instanceof ProjectRecoveryRequired
            ? "unknown"
            : outcome,
        retry_safe: false,
      };
    },
  };
}
