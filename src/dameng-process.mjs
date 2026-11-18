import { fork, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileDamengRead } from "./dameng-read-contract.mjs";

const unavailable = "DAMENG_VERIFIED_TRANSPORT_UNAVAILABLE";
const failed = "DAMENG_READ_FAILED_NO_RESULT";
const cancelled = "DAMENG_READ_CANCELLED";
const timeout = "DAMENG_READ_TIMEOUT";
const executable = fileURLToPath(
  new URL(
    "./vendor/dameng-native/workbench-dameng-read" +
      (process.platform === "win32" ? ".exe" : ""),
    import.meta.url,
  ),
);
const cap = 1024 * 1024;
let activeNativeReads = 0;

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

export function damengPreviewEnabled() {
  return (
    process.env.LOCALAPI_DAMENG_PREVIEW === "read-only" &&
    existsSync(executable)
  );
}

export function runDamengProcess(input, { signal } = {}) {
  const plan = compileDamengRead(input);
  if (signal?.aborted) return Promise.reject(Error(cancelled));
  if (!damengPreviewEnabled()) return Promise.reject(Error(unavailable));
  const { host, port, user, password, ca } = plan.config;
  const parameters = [];
  // Only the compiler's quoted identifiers and generated parameter slots reach this step.
  const sql = plan.sql.replace(/:p(\d+)/g, (_, index) => {
    parameters.push(plan.binds["p" + index]);
    return "?";
  });
  const request = JSON.stringify({
    host,
    port,
    user,
    password,
    ca,
    sql,
    columns: plan.columns,
    parameters,
  });
  if (Buffer.byteLength(request) > 524288) return Promise.reject(Error(failed));
  if (activeNativeReads >= 2) return Promise.reject(Error("DAMENG_READ_BUSY"));
  activeNativeReads++;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      windowsHide: true,
      env:
        process.platform === "win32"
          ? { SystemRoot: process.env.SystemRoot }
          : {},
      stdio: ["pipe", "pipe", "ignore"],
    });
    let size = 0,
      reason;
    const chunks = [];
    const stop = (message) => {
      reason ??= message;
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    };
    const abort = () => stop(cancelled);
    const timer = setTimeout(() => stop(timeout), 8000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", () => stop(failed));
    child.stdin.on("error", () => stop(failed));
    child.stdout.on("error", () => stop(failed));
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > cap) stop(failed);
      else chunks.push(chunk);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (reason || code !== 0) return reject(Error(reason || failed));
      try {
        const result = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
        if (!boundedResult(result, plan.columns)) throw Error(failed);
        resolve(result);
      } catch {
        reject(Error(failed));
      }
    });
    child.stdin.end(request);
  }).finally(() => {
    activeNativeReads--;
  });
}
