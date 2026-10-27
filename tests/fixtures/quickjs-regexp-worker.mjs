import { parentPort, workerData } from "node:worker_threads";
import { trackedQuickJS } from "../../src/tracked-quickjs.mjs";

const tracked = await trackedQuickJS(workerData.compiled);
const runtime = tracked.engine.newRuntime();
runtime.setMemoryLimit(16 * 1024 * 1024);
runtime.setMaxStackSize(512 * 1024);
const context = runtime.newContext();
const started = Date.now(),
  deadline = started + 250;
let checks = 0,
  expiredChecks = 0;
runtime.setInterruptHandler(() => {
  checks++;
  const expired = Date.now() > deadline;
  if (expired) expiredChecks++;
  return expired;
});
let output;
try {
  const result = context.evalCode(
    workerData.source,
    "regexp-interrupt-test.js",
  );
  const handle = result.error || result.value;
  try {
    output = {
      error: !!result.error,
      value: context.dump(handle),
      elapsedMs: Date.now() - started,
      checks,
      expiredChecks,
    };
  } finally {
    handle.dispose();
  }
  // Read only independently authored own boolean data, without another guest
  // evaluation or resetting an expired deadline merely to inspect its outcome.
  for (const key of ["caught", "after"]) {
    const value = context.getProp(context.global, key);
    try {
      output[key] = context.dump(value);
    } finally {
      value.dispose();
    }
  }
} finally {
  context.dispose();
  runtime.dispose();
}
output.unhandledAfterDispose = tracked.unhandledCount();
parentPort.postMessage(output);
