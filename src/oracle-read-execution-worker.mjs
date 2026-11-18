// Fixed internal implementation. No caller-selected driver, URL or module.
import { parentPort, workerData } from "node:worker_threads";
import tls from "node:tls";
import { validateOracleReadTrust } from "./oracle-read-trust.mjs";
import { compileOracleRead } from "./oracle-read-contract.mjs";
import { executeOracleRead } from "./oracle-read.mjs";
const controller = new AbortController();
parentPort.on("message", (message) => {
  if (message?.kind === "cancel") controller.abort();
});
try {
  const { input, trust } = workerData;
  compileOracleRead(input);
  const validated = validateOracleReadTrust(input, trust);
  if (validated) {
    if (typeof tls.setDefaultCACertificates !== "function") throw Error();
    // This dedicated worker serves one owned query, then exits. Replace, do not
    // augment, its roots. Owner/supervisor threads and later reads are untouched.
    tls.setDefaultCACertificates([validated.ca]);
  }
  const result = await executeOracleRead(input, {
    signal: controller.signal,
    onClosing: () => parentPort.postMessage({ kind: "closing" }),
  });
  parentPort.postMessage({ kind: "result", result });
} catch {
  parentPort.postMessage({ kind: "failure" });
} finally {
  parentPort.close();
}
