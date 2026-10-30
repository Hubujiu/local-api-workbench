import { appendExecutionRecord } from "./execution-evidence.mjs";

// Storage retries must never replay an already completed network operation.
export async function recordPlanRun(store, projectId, run, source) {
  return {
    ...run,
    ...(await appendExecutionRecord(store, projectId, "runs", {
      ...run,
      source,
    })),
  };
}
