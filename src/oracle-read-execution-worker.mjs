// Fixed internal implementation. No caller-selected driver, URL or module.
import { parentPort, workerData } from "node:worker_threads";
import { setDefaultCACertificates } from "node:tls";
import { executeOracleRead } from "./oracle-read.mjs";
const controller = new AbortController();
parentPort.on("message", (message) => {
  if (message?.kind === "cancel") controller.abort();
});
try {
  const result = await executeOracleRead(workerData, {
    // This one-query worker owns its TLS defaults; the application and other grants stay isolated.
    setTrustedCertificates: setDefaultCACertificates,
    signal: controller.signal,
    onClosing: () => parentPort.postMessage({ kind: "closing" }),
  });
  parentPort.postMessage({ kind: "result", result });
} catch (error) {
  parentPort.postMessage({
    kind: "failure",
    stage: error.stage,
    driverCode: error.driverCode,
  });
} finally {
  parentPort.close();
}
