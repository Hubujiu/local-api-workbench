import { isMainThread, parentPort, workerData } from "node:worker_threads";

// This preload belongs only to the subprocess regression. No production input,
// environment flag or guest capability can enable the injected host pauses.
if (!isMainThread && workerData?.code) {
  const mode = process.env.LOCAL_API_ACCOUNTING_PROBE;
  let stage,
    samples = 0,
    paused = false;
  const postMessage = parentPort.postMessage.bind(parentPort);
  parentPort.postMessage = (message, ...rest) => {
    if (message?.kind === "stage") {
      stage = message.stage;
      samples = 0;
    }
    return postMessage(message, ...rest);
  };
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const pause = (milliseconds) => {
    paused = true;
    process.stderr.write("SCRIPT_ACCOUNTING_PAUSE " + mode + "\n");
    Atomics.wait(wait, 0, 0, milliseconds);
  };
  const cpu = process.threadCpuUsage?.bind(process);
  process.threadCpuUsage = (...args) => {
    samples++;
    if (!paused) {
      if (
        mode === "compatibility" &&
        workerData.activityBudgetMs < 250 &&
        stage === "compatibility" &&
        samples === 1
      )
        pause(300);
      if (
        mode === "serialization" &&
        stage === "serialization" &&
        samples === 2
      )
        pause(300);
      if (mode === "total-wall" && stage === "compatibility" && samples === 1)
        pause(2500);
    }
    return cpu ? cpu(...args) : { user: 0, system: 0 };
  };
  if (mode === "host-parse" || mode === "evidence-parse") {
    const parse = JSON.parse;
    JSON.parse = (...args) => {
      if (!paused && mode === "host-parse" && stage === "serialization")
        pause(300);
      if (
        !paused &&
        mode === "evidence-parse" &&
        stage === "async-completion" &&
        typeof args[0] === "string" &&
        args[0].startsWith("[") &&
        args[0].includes('"record"')
      )
        pause(300);
      return Reflect.apply(parse, JSON, args);
    };
  }
}
