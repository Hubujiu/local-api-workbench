// One-shot transport for authorised Oracle reads. Each invocation owns one child and never replays.
import { fork } from "node:child_process";
import { performance } from "node:perf_hooks";
import { compileOracleRead } from "./oracle-read-contract.mjs";
import { ORACLE_READ_BUDGET as budget } from "./oracle-read-process-policy.mjs";
const owners = new Set();
const error = (code, reason = code) =>
  Object.assign(Error(`Oracle read failed: ${code}; no result published`), {
    code,
    reason,
  });
const check = (signal) => {
  if (signal?.aborted) throw error("ORACLE_READ_CANCELLED");
};
export async function queryOracleRead(input, { signal } = {}) {
  check(signal);
  if (owners.size >= budget.capacity || [...owners].some((o) => o.quarantined))
    throw error("ORACLE_READ_BUSY");
  const owner = { quarantined: false };
  owners.add(owner);
  const started = performance.now();
  let transferred = false;
  try {
    compileOracleRead(input);
    input = structuredClone(input);
    check(signal);
    const remaining = budget.total - (performance.now() - started);
    if (remaining <= 0) throw error("ORACLE_READ_TIMEOUT");
    const promise = new Promise((resolve, reject) => {
      let child,
        candidate,
        closed = false,
        settled = false,
        closing = false;
      let cause,
        killRequested = false,
        closeTimer,
        killTimer,
        totalTimer;
      const settle = (e, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        clearTimeout(closeTimer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", cancel);
        if (e) reject(e);
        else resolve(result);
      };
      const unconfirmed = () => {
        owner.quarantined = true;
        settle(
          error(
            "ORACLE_READ_CLEANUP_UNCONFIRMED",
            cause || "ORACLE_READ_CLEANUP_TIMEOUT",
          ),
        );
        // Keep ownership until an actual close event, even after bounded return.
      };
      const kill = () => {
        if (closed || killRequested) return;
        killRequested = true;
        candidate = undefined;
        killTimer = setTimeout(unconfirmed, budget.killReceipt);
        try {
          child.kill("SIGKILL");
        } catch {
          /* Await OS receipt or quarantine. */
        }
      };
      const beginClose = () => {
        if (closed || closing) return;
        closing = true;
        closeTimer = setTimeout(kill, budget.cleanup);
      };
      const stop = (code) => {
        if (closed || settled) return;
        cause ??= code;
        candidate = undefined;
        beginClose();
        try {
          if (child.connected) child.send({ kind: "cancel" }, () => {});
        } catch {
          kill();
        }
      };
      const cancel = () => stop("ORACLE_READ_CANCELLED");
      try {
        child = fork(
          new URL("./oracle-read-process-entry.mjs", import.meta.url),
          {
            execArgv: ["--max-old-space-size=160"],
            // Credentials never enter argv/env. Avoid inherited NODE_OPTIONS,
            // credential providers, proxy options and arbitrary preload scripts.
            env: {
              ...(process.platform === "win32" && process.env.SystemRoot
                ? { SystemRoot: process.env.SystemRoot }
                : {}),
              ...(process.versions.electron
                ? { ELECTRON_RUN_AS_NODE: "1" }
                : {}),
            },
            serialization: "advanced",
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            windowsHide: true,
          },
        );
      } catch {
        settle(error("ORACLE_READ_SPAWN_FAILED"));
        return;
      }
      transferred = true;
      totalTimer = setTimeout(() => stop("ORACLE_READ_TIMEOUT"), remaining);
      child.on("error", () => stop("ORACLE_READ_PROCESS_FAILED"));
      child.on("message", (message) => {
        if (settled || closed || killRequested) return;
        if (message?.kind === "closing") {
          beginClose();
          return;
        }
        if (message?.kind === "failure") {
          stop("ORACLE_READ_EXECUTION_FAILED");
          return;
        }
        if (message?.kind !== "result" || !closing || candidate || cause) {
          stop("ORACLE_READ_PROTOCOL_FAILED");
          return;
        }
        try {
          const result = message.result;
          if (
            !result ||
            !Array.isArray(result.columns) ||
            !Array.isArray(result.rows) ||
            result.rows.length > 1000 ||
            result.truncated !== false ||
            result.limit !== 1000 ||
            Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024
          )
            throw Error();
          candidate = result;
        } catch {
          stop("ORACLE_READ_PROTOCOL_FAILED");
        }
      });
      child.once("close", (code, exitSignal) => {
        closed = true;
        owners.delete(owner);
        if (settled) return;
        if (killRequested || exitSignal) {
          settle(
            error(
              "ORACLE_READ_FORCED_TERMINATION_CONFIRMED",
              cause ||
                (closing
                  ? "ORACLE_READ_CLEANUP_TIMEOUT"
                  : "ORACLE_READ_PROCESS_TERMINATED"),
            ),
          );
          return;
        }
        if (signal?.aborted) cause = "ORACLE_READ_CANCELLED";
        if (cause || code !== 0 || !candidate) {
          settle(error(cause || "ORACLE_READ_PROCESS_FAILED"));
          return;
        }
        settle(null, candidate);
      });
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      else {
        try {
          child.send({ kind: "start", input }, (e) => {
            if (e) stop("ORACLE_READ_IPC_FAILED");
          });
        } catch {
          stop("ORACLE_READ_IPC_FAILED");
        }
      }
    });
    return await promise;
  } finally {
    if (!transferred) owners.delete(owner);
  }
}
