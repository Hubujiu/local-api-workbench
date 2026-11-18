import { parentPort, workerData } from "node:worker_threads";
import { runDamengRead } from "./dameng-read.mjs";

const unavailable = "DAMENG_VERIFIED_TRANSPORT_UNAVAILABLE";
try {
  // No reviewed transport is built in yet. Keep the production entry closed;
  // neither IPC nor the parent application may supply executable driver code.
  const result = await runDamengRead(workerData);
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({
    error:
      error.message === unavailable
        ? unavailable
        : "DAMENG_READ_FAILED_NO_RESULT",
  });
}
