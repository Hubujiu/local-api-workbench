// Test-only substitute worker. Never imported by production modules.
import { parentPort, workerData } from "node:worker_threads";
import { appendFileSync } from "node:fs";
if (workerData.sql === "hang") {
  // Heartbeats prove the worker was actually running and stops after timeout.
  const path = workerData.parameters[0].value;
  appendFileSync(path, "started\n");
  setInterval(() => appendFileSync(path, "tick\n"), 20);
  setTimeout(() => {
    appendFileSync(path, "late\n");
    parentPort.postMessage({ result: "late" });
  }, 3000);
} else {
  parentPort.postMessage({ result: "capacity restored" });
}
