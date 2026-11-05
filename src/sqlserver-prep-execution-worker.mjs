// Fixed internal implementation. No caller-selected driver, URL or module.
import { parentPort, workerData } from "node:worker_threads";
import { runCompiledSQLServerPreparation } from "./sqlserver-read-prep.mjs";
import { createTediousSQLServerPort } from "./sqlserver-tedious-prep.mjs";
const controller = new AbortController();
parentPort.on("message", (message) => {
  if (message?.kind === "cancel") controller.abort();
});
try {
  const result = await runCompiledSQLServerPreparation(workerData, {
    factory: createTediousSQLServerPort,
    signal: controller.signal,
    onClosing: () => parentPort.postMessage({ kind: "closing" }),
  });
  parentPort.postMessage({ kind: "result", result });
} catch {
  parentPort.postMessage({ kind: "failure" });
} finally {
  parentPort.close();
}
