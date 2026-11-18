import { fork } from "node:child_process";
import { compileDamengRead } from "./dameng-read-contract.mjs";

const unavailable = "DAMENG_VERIFIED_TRANSPORT_UNAVAILABLE";
const failed = "DAMENG_READ_FAILED_NO_RESULT";
const cancelled = "DAMENG_READ_CANCELLED";
const timeout = "DAMENG_READ_TIMEOUT";
const processEntry = new URL("./dameng-process-entry.mjs", import.meta.url);
const cap = 1024 * 1024;

function boundedResult(value, columns) {
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "columns,limit,rows,truncated" ||
    value.limit !== 1000 ||
    value.truncated !== false ||
    !Array.isArray(value.columns) ||
    value.columns.length !== columns.length ||
    !columns.every((name, i) => value.columns[i] === name) ||
    !Array.isArray(value.rows) ||
    value.rows.length > 1000
  )
    return false;
  for (const row of value.rows) {
    if (!row || Object.keys(row).length !== columns.length) return false;
    for (const name of columns) {
      if (!Object.hasOwn(row, name)) return false;
      const v = row[name];
      if (v === null || (typeof v === "string" && v.isWellFormed())) continue;
      if (
        !v ||
        Object.keys(v).sort().join(",") !== "base64,type" ||
        v.type !== "blob" ||
        typeof v.base64 !== "string" ||
        v.base64.length > cap ||
        Buffer.from(v.base64, "base64").toString("base64") !== v.base64
      )
        return false;
    }
  }
  return Buffer.byteLength(JSON.stringify(value)) <= cap + 100;
}

// The entry is an application-owned module URL, never a request field.
export function superviseDamengProcess(entry, input, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(Error(cancelled));
  const plan = compileDamengRead(input);
  const { host, port, user, password, serverName, ca } = plan.config;
  // Strip getters, accidental secrets and any possible module/path overrides.
  const request = {
    connection: { host, port, user, password, serverName, ca, ssl: true },
    sql: plan.inputSql,
    parameters: Object.values(plan.binds),
  };
  return new Promise((resolve, reject) => {
    let child, receipt, fault, reason;
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          fault = true;
        }
      }
    };
    const onAbort = () => {
      reason = cancelled;
      kill();
    };
    try {
      child = fork(entry, {
        execArgv: ["--max-old-space-size=32"],
        env: {
          ...(process.platform === "win32" && process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
    } catch {
      reject(Error(failed));
      return;
    }
    const timer = setTimeout(() => {
      reason ??= timeout;
      kill();
    }, 2000);
    child.on("error", () => {
      fault = true;
      kill();
    });
    child.on("message", (value) => {
      if (
        receipt ||
        value?.type !== "dameng-result" ||
        Object.keys(value).length !== 2 ||
        !(
          value.error === unavailable ||
          value.error === failed ||
          boundedResult(value.result, plan.columns)
        )
      ) {
        fault = true;
        kill();
        return;
      }
      receipt = value;
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (reason) reject(Error(reason));
      else if (fault || code !== 0 || exitSignal || !receipt)
        reject(Error(failed));
      else if (receipt.error) reject(Error(receipt.error));
      else resolve(receipt.result);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (!reason) {
      try {
        child.send(request, (error) => {
          if (error) {
            fault = true;
            kill();
          }
        });
      } catch {
        fault = true;
        kill();
      }
    }
  });
}

export function runDamengProcess(input, options) {
  return superviseDamengProcess(processEntry, input, options);
}
