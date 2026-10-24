import { Worker } from "node:worker_threads";
// The supervisor stays responsive even while its execution thread is inside C.
// Losing the parent must not leave an orphaned native query with no deadline.
process.once("message", (input) => {
  let finishing = false;
  const terminate = () => process.kill(process.pid, "SIGKILL");
  const timer = setTimeout(terminate, 2000);
  process.once("disconnect", () => {
    if (!finishing) terminate();
  });
  let message, failure;
  const worker = new Worker(
    new URL("./database-execution-worker.mjs", import.meta.url),
    {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: 64 },
      execArgv: [],
    },
  );
  worker.once("message", (value) => {
    message = value;
  });
  worker.once("error", (error) => {
    failure = error;
  });
  worker.once("exit", (code) => {
    clearTimeout(timer);
    if (code !== 0 || failure || !message) {
      process.exitCode = 1;
      finishing = true;
      if (process.connected) process.disconnect();
      return;
    }
    // SQL completed and its handle closed before the worker posted a result;
    // worker exit is checked too. The supervisor never reruns an operation.
    process.send(message, (error) => {
      finishing = true;
      if (error) process.exitCode = 1;
      if (process.connected) process.disconnect();
    });
  });
});
