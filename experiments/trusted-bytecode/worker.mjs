import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { createExperimentSession } from "./runtime.mjs";

const started = performance.now();
let session;
try {
  if (!["fixture", "loop", "wait"].includes(workerData.operation))
    throw Error("Unknown fixed worker operation");
  session = await createExperimentSession();
  parentPort.postMessage({ kind: "ready" });
  if (workerData.operation === "wait") await new Promise(() => {});
  session.load(workerData.operation === "loop" ? "looping" : "fixture");
  parentPort.postMessage({
    kind: "result",
    ok: true,
    activityMs: session.budget.elapsed(),
    elapsed: performance.now() - started,
  });
} catch (error) {
  parentPort.postMessage({
    kind: "result",
    ok: false,
    error: error.message,
    elapsed: performance.now() - started,
  });
} finally {
  session?.dispose();
}
