import { fork } from "node:child_process";

// A native SQLite call does not yield to Worker.terminate(). An owned process
// supplies a real termination boundary, without changing the two-second budget.
export function runSQLiteProcess(input) {
  return new Promise((resolve, reject) => {
    const child = fork(
      new URL("./database-process-entry.mjs", import.meta.url),
      {
        execArgv: ["--max-old-space-size=64"],
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      },
    );
    let message,
      failure,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 2000);
    child.once("message", (value) => {
      message = value;
      // Keep the deadline until close. A message alone is not proof that the
      // database handle, native computation and child process have gone away.
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!timedOut && !failure && code === 0 && message) {
        if (message.error) reject(Error(message.error));
        else resolve(message.result);
        return;
      }
      if (input.mode === "write") {
        const error = Error("数据库写入结果未确认，请先查询数据，不要直接重试");
        error.code = "SQLITE_WRITE_OUTCOME_UNKNOWN";
        error.cause = failure;
        reject(error);
      } else {
        const error = Error(
          timedOut
            ? "数据库查询超过 2 秒，执行进程已终止"
            : "数据库查询进程失败",
        );
        error.code = timedOut
          ? "SQLITE_QUERY_TIMEOUT"
          : "SQLITE_QUERY_PROCESS_FAILED";
        error.cause = failure;
        reject(error);
      }
    });
    const sendFailed = (error) => {
      if (!error) return;
      failure = error;
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    };
    try {
      child.send(input, sendFailed);
    } catch (error) {
      sendFailed(error);
    }
  });
}
