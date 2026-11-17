import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { querySQLite, mutateSQLite } from "./database.mjs";
import { createSQLiteOperationTracker } from "./sqlite-operation-progress.mjs";
parentPort.postMessage({ kind: "sqlite-worker-ready" });
let progress, started;
const observe = (stage) => {
  try {
    if (!progress) {
      progress = createSQLiteOperationTracker();
      started = performance.now();
    }
    const value = progress({
      kind: "sqlite-operation-stage",
      stage,
      elapsedMs: Math.min(
        86400000,
        Math.max(0, Math.round(performance.now() - started)),
      ),
    });
    if (value) parentPort.postMessage(value);
  } catch {}
};
try {
  if (!workerData || !["read", "write"].includes(workerData.mode))
    throw Error("数据库操作模式无效");
  parentPort.postMessage({
    result: (workerData.mode === "write" ? mutateSQLite : querySQLite)(
      workerData.filename,
      workerData.sql,
      workerData.parameters,
      observe,
    ),
  });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
