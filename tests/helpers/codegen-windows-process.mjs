import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The Windows owner atomically creates the target suspended in a Job Object.
// Only an OS ActiveProcesses=0 receipt permits cleanupConfirmed.
export async function runWindowsFixtureProcess(
  binary,
  args,
  { phase, fixture, timeoutMs, signal, env, cwd },
) {
  let timedOut = false,
    aborted = false,
    wrapperFailed = false;
  let wrapperClosed = false,
    wrapperSignal = null,
    output = "";
  let killTimer, closeTimer;
  const child = spawn(
    "python3",
    [
      "-I",
      "-X",
      "utf8",
      "-u",
      fileURLToPath(new URL("./codegen-windows-job.py", import.meta.url)),
    ],
    {
      env,
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => {
    if (output.length + chunk.length <= 8192) output += chunk;
    else wrapperFailed = true;
  });
  const closed = new Promise((resolve) => {
    child.once("error", () => {
      wrapperFailed = true;
    });
    child.once("close", (code, receivedSignal) => {
      wrapperClosed = true;
      wrapperSignal = receivedSignal;
      if (code !== 0) wrapperFailed = true;
      resolve();
    });
  });
  let stopResolve;
  const stopRequested = new Promise((resolve) => {
    stopResolve = resolve;
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.stdin.end("stop\n");
    // Closing the wrapper also closes its non-inherited KILL_ON_JOB_CLOSE
    // handle. Without its OS receipt this remains cleanup-unconfirmed failure.
    killTimer = setTimeout(() => {
      wrapperFailed = true;
      child.kill();
    }, 3000);
    closeTimer = setTimeout(stopResolve, 6000);
  };
  child.stdin.write(JSON.stringify({ binary, args }) + "\n");
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  const abort = () => {
    aborted = true;
    stop();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  await Promise.race([closed, stopRequested]);
  clearTimeout(timer);
  clearTimeout(killTimer);
  clearTimeout(closeTimer);
  signal?.removeEventListener("abort", abort);
  child.stdin.destroy();
  let owner;
  try {
    owner = JSON.parse(output);
  } catch {
    wrapperFailed = true;
  }
  const valid =
    owner &&
    typeof owner.cleanupConfirmed === "boolean" &&
    typeof owner.childClosed === "boolean" &&
    typeof owner.admissionFailed === "boolean" &&
    (owner.exitCode === null || Number.isInteger(owner.exitCode));
  const stages = new Set([
    null,
    "admission",
    "job-create",
    "job-configure",
    "job-attributes",
    "atomic-job-admission",
    "resume",
    "execute",
    "job-terminate",
    "job-cleanup-receipt",
  ]);
  const receipt = {
    phase,
    fixture,
    exitCode: valid ? owner.exitCode : null,
    signal: null,
    wrapperSignal,
    timedOut,
    aborted,
    spawnFailed: wrapperFailed,
    admissionFailed: valid ? owner.admissionFailed : null,
    cleanupStage: valid && stages.has(owner.stage) ? owner.stage : null,
    childClosed: valid && owner.childClosed,
    cleanupConfirmed: Boolean(
      valid && !wrapperFailed && wrapperClosed && owner.cleanupConfirmed,
    ),
  };
  if (
    receipt.exitCode !== 0 ||
    timedOut ||
    aborted ||
    wrapperFailed ||
    receipt.admissionFailed ||
    !receipt.cleanupConfirmed
  )
    throw Object.assign(Error(JSON.stringify(receipt)), { receipt });
  return receipt;
}
