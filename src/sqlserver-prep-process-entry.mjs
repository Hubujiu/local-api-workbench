// This main thread remains responsive when the execution worker is stuck.
import { Worker } from "node:worker_threads";
import { SQLSERVER_PREP_BUDGET as budget } from "./sqlserver-prep-process-policy.mjs";
let worker,
  started = false,
  closing = false,
  candidate,
  failure = false;
const kill = () => process.kill(process.pid, "SIGKILL");
let cleanupTimer;
const totalTimer = setTimeout(kill, budget.total + budget.cleanup);
process.once("disconnect", kill);
const send = (message, callback = () => {}) => {
  try {
    if (!process.connected) return kill();
    process.send(message, (error) => (error ? kill() : callback()));
  } catch {
    kill();
  }
};
const close = () => {
  if (closing) return;
  closing = true;
  send({ kind: "closing" });
  cleanupTimer = setTimeout(kill, budget.cleanup);
};
process.on("message", (message) => {
  if (message?.kind === "cancel") {
    failure = true;
    close();
    worker?.postMessage({ kind: "cancel" });
    return;
  }
  if (message?.kind !== "start" || started || closing) return kill();
  started = true;
  try {
    worker = new Worker(
      new URL("./sqlserver-prep-execution-worker.mjs", import.meta.url),
      {
        workerData: message.input,
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 2,
        },
      },
    );
  } catch {
    return kill();
  }
  worker.on("message", (value) => {
    if (value?.kind === "closing") return close();
    if (value?.kind === "failure") {
      failure = true;
      close();
      return;
    }
    if (value?.kind !== "result" || candidate || !closing || failure) {
      failure = true;
      close();
      return;
    }
    candidate = value.result;
  });
  worker.once("error", () => {
    failure = true;
    close();
  });
  worker.once("exit", (code) => {
    if (code !== 0 || !candidate || failure) {
      failure = true;
      close();
    }
    send(
      failure ? { kind: "failure" } : { kind: "result", result: candidate },
      () => {
        clearTimeout(totalTimer);
        clearTimeout(cleanupTimer);
        process.exitCode = failure ? 1 : 0;
        process.removeListener("disconnect", kill);
        process.disconnect();
      },
    );
  });
});
