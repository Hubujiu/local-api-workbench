import { Worker } from "node:worker_threads";
import {
  sqliteProcessErrorCode,
  sqliteExitCode,
} from "./sqlite-process-diagnostics.mjs";
// The supervisor stays responsive even while its execution thread is inside C.
// Losing the parent must not leave an orphaned native query with no deadline.
process.once("message", (input) => {
  let finishing = false;
  const terminate = () => process.kill(process.pid, "SIGKILL");
  const timer = setTimeout(terminate, 2000);
  process.once("disconnect", () => {
    if (!finishing) terminate();
  });
  const stage = (name, details = {}) => {
    if (!process.connected) return;
    try {
      process.send({ kind: "sqlite-stage", stage: name, ...details }, () => {});
    } catch {}
  };
  stage("supervisor-ready");
  let message, failure;
  const failWorker = (error) => {
    stage("worker-error", { errorCode: sqliteProcessErrorCode(error) });
    timer.unref();
    process.exitCode = 1;
    finishing = true;
    if (process.connected) process.disconnect();
  };
  let worker;
  try {
    worker = new Worker(
      new URL("./database-execution-worker.mjs", import.meta.url),
      {
        workerData: input,
        resourceLimits: { maxOldGenerationSizeMb: 64 },
        execArgv: [],
      },
    );
  } catch (error) {
    failWorker(error);
    return;
  }
  worker.once("online", () => stage("worker-online"));
  worker.on("message", (value) => {
    if (value?.kind === "sqlite-worker-ready") {
      stage("worker-ready");
      return;
    }
    message = value;
    stage("worker-result");
  });
  worker.once("error", (error) => {
    failure = error;
    stage("worker-error", { errorCode: sqliteProcessErrorCode(error) });
  });
  worker.once("exit", (code) => {
    stage("worker-exit", { exitCode: sqliteExitCode(code) });
    if (code !== 0 || failure || !message) {
      timer.unref();
      process.exitCode = 1;
      finishing = true;
      if (process.connected) process.disconnect();
      return;
    }
    // Never extend the deadline waiting for result IPC. No operation is replayed.
    process.send({ kind: "sqlite-result", payload: message }, (error) => {
      timer.unref();
      finishing = true;
      if (error) process.exitCode = 1;
      if (process.connected) process.disconnect();
    });
  });
});
