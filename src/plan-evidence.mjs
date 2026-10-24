// Storage retries must never replay an already completed network operation.
export async function recordPlanRun(store, projectId, run, source) {
  try {
    await store.append(projectId, "runs", { ...run, source });
    return { ...run, recordSaved: true };
  } catch (error) {
    return {
      ...run,
      recordSaved: false,
      persistenceError: String(error.message || error),
    };
  }
}
