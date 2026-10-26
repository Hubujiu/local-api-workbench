import {
  checkDatabaseSignal,
  databaseCancelled,
} from "./database-read-cancellation.mjs";
import { fork } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  sqliteProcessErrorCode,
  sqliteProcessStages,
  sqliteExitCode,
} from "./sqlite-process-diagnostics.mjs";

// A native SQLite call does not yield to Worker.terminate(). An owned process
// supplies a real termination boundary, without changing the two-second budget.
export function runSQLiteProcess(input, { signal } = {}) {
  // Mutations retain their separate uncertain-outcome contract.
  if (input.mode !== "read") signal = undefined;
  checkDatabaseSignal(signal);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const elapsed = () =>
      Math.min(86400000, Math.max(0, Math.round(performance.now() - started)));
    let child,
      message,
      failure,
      timedOut = false,
      phase = "fork-pending";
    let spawned = false;
    let processErrorCode = null;
    let spawnErrorCode = null,
      sendErrorCode = null,
      workerErrorCode = null,
      workerExitCode = null;
    const checkpoints = {
      supervisorReadyMs: null,
      workerReadyMs: null,
      resultReceivedMs: null,
    };
    const fail = (code = null, signal = null) => {
      const error = Error(
        input.mode === "write"
          ? "数据库写入结果未确认，请先查询数据，不要直接重试"
          : timedOut
            ? "数据库查询超过 2 秒，执行进程已终止"
            : "数据库查询进程失败",
      );
      error.code =
        input.mode === "write"
          ? "SQLITE_WRITE_OUTCOME_UNKNOWN"
          : timedOut
            ? "SQLITE_QUERY_TIMEOUT"
            : "SQLITE_QUERY_PROCESS_FAILED";
      error.diagnostics = {
        phase,
        elapsedMs: elapsed(),
        timeout: timedOut,
        exitCode: sqliteExitCode(code),
        signal:
          typeof signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(signal)
            ? signal
            : null,
        receivedResult: Boolean(message),
        spawnErrorCode,
        processErrorCode,
        sendErrorCode,
        workerErrorCode,
        workerExitCode,
        ...checkpoints,
      };
      if (failure) error.cause = { code: sqliteProcessErrorCode(failure) };
      reject(error);
    };
    try {
      child = fork(new URL("./database-process-entry.mjs", import.meta.url), {
        execArgv: ["--max-old-space-size=16"],
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
    } catch (error) {
      failure = error;
      spawnErrorCode = sqliteProcessErrorCode(error);
      fail();
      return;
    }
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => {
      if (cancelled) return;
      timedOut = true;
      child.kill("SIGKILL");
    }, 2000);
    child.once("spawn", () => {
      spawned = true;
      phase = "process-spawned";
    });
    child.on("message", (value) => {
      if (
        value?.kind === "sqlite-stage" &&
        sqliteProcessStages.has(value.stage)
      ) {
        phase = value.stage;
        if (
          value.stage === "supervisor-ready" &&
          checkpoints.supervisorReadyMs === null
        )
          checkpoints.supervisorReadyMs = elapsed();
        if (
          value.stage === "worker-ready" &&
          checkpoints.workerReadyMs === null
        )
          checkpoints.workerReadyMs = elapsed();
        if (value.stage === "worker-exit")
          workerExitCode = sqliteExitCode(value.exitCode);
        if (value.stage === "worker-error")
          workerErrorCode = sqliteProcessErrorCode({ code: value.errorCode });
        return;
      }
      const payload = value?.payload;
      if (
        value?.kind === "sqlite-result" &&
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        ((Object.hasOwn(payload, "result") &&
          !Object.hasOwn(payload, "error") &&
          payload.result &&
          typeof payload.result === "object" &&
          !Array.isArray(payload.result)) ||
          (!Object.hasOwn(payload, "result") &&
            typeof payload.error === "string"))
      ) {
        message = payload;
        phase = "result-received";
        checkpoints.resultReceivedMs = elapsed();
      }
      // Status IPC is not success. Keep the deadline until process close.
    });
    child.on("error", (error) => {
      failure = error;
      if (spawned) processErrorCode = sqliteProcessErrorCode(error);
      else spawnErrorCode = sqliteProcessErrorCode(error);
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (cancelled) {
        reject(databaseCancelled());
        return;
      }
      if (!timedOut && !failure && code === 0 && message) {
        if (Object.hasOwn(message, "error")) reject(Error(message.error));
        else resolve(message.result);
        return;
      }
      fail(code, exitSignal);
    });
    const sendFailed = (error) => {
      if (!error) return;
      failure = error;
      sendErrorCode = sqliteProcessErrorCode(error);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    };
    try {
      if (!cancelled) child.send(input, sendFailed);
    } catch (error) {
      sendFailed(error);
    }
  });
}
