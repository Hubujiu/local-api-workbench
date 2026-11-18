import { Worker } from "node:worker_threads";

const fail = "DAMENG_READ_FAILED_NO_RESULT";
let finishing = false;
const terminate = () => process.kill(process.pid, "SIGKILL");
const timer = setTimeout(terminate, 2000);

// IPC loss must still terminate an isolated native driver call. The worker
// thread, not this process's event loop, will own any future driver.
process.once("disconnect", () => {
  if (!finishing) terminate();
});
process.once("message", (input) => {
  if (!process.connected) return terminate();
  let result;
  let worker;
  const finish = (value) => {
    if (finishing || !process.connected) return terminate();
    process.send({ type: "dameng-result", ...value }, (error) => {
      clearTimeout(timer);
      finishing = true;
      if (error) process.exitCode = 1;
      if (process.connected) process.disconnect();
    });
  };
  try {
    worker = new Worker(
      new URL("./dameng-process-worker.mjs", import.meta.url),
      {
        workerData: input,
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      },
    );
  } catch {
    finish({ error: fail });
    return;
  }
  worker.on("message", (value) => {
    if (result) return terminate();
    result = value;
  });
  worker.once("error", () => terminate());
  worker.once("exit", (code) =>
    finish(code === 0 && result ? result : { error: fail }),
  );
});
