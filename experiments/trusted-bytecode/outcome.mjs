// A worker may publish success only after its guest resources are released.
// Disposal is idempotent: the finally also covers budget.begin rejecting before
// the charged callback had a chance to run.
export function completeSession(session, outcome) {
  if (!session) return outcome;
  try {
    if (outcome.ok) {
      try {
        session.budget.run("dispose-session", () => session.dispose());
      } finally {
        session.dispose();
      }
    } else {
      session.dispose();
    }
  } catch (error) {
    return { ok: false, error: "Session cleanup failed: " + error.message };
  }
  return outcome.ok
    ? {
        ...outcome,
        activityMs: session.budget.elapsed(),
        metrics: session.budget.metrics,
      }
    : outcome;
}
