import { normalizeNativeWaitData } from "./native-wait-tasks.mjs";
import {
  normalizeNativeAssertionData,
  isNativeVariableAssertion,
} from "./native-response-assertions.mjs";
import {
  nativeDataArray,
  nativeDataObject,
  normalizePickVarsData,
  isNativeRequestPick,
} from "./native-response-extraction.mjs";
import { randomBytes } from "node:crypto";
import { normalizeDatabaseOperations } from "./script-database-tasks.mjs";
import { runScript } from "./scripts.mjs";

const extractionPhaseFailure = Symbol("native-response-extraction-phase");
export const isNativeExtractionPhaseFailure = (error) =>
  error?.[extractionPhaseFailure] === true;

/** Ordered native tasks share one isolated VM lexical scope. */
export function runNativeTaskPhase(tasks, input, options = {}) {
  nativeDataArray(tasks, 16);
  if (!Array.isArray(tasks) || tasks.length > 16)
    throw Error("原版任务阶段最多16项");
  const operations = [],
    responseExtractions = [],
    responseAssertions = [],
    nativeWaits = [],
    code = [],
    prefix = "__db_" + randomBytes(16).toString("hex");
  const waitPrefix = "__wait_" + randomBytes(16).toString("hex");
  const assertPrefix = "__assert_" + randomBytes(16).toString("hex");
  const pickPrefix = "__pick_" + randomBytes(16).toString("hex");
  let bytes = 0;
  for (const task of tasks) {
    nativeDataObject(task, ["type", "enabled", "data", "id", "name", "origin"]);
    if (
      !task ||
      typeof task !== "object" ||
      Array.isArray(task) ||
      ![1, 0, -1].includes(task.enabled) ||
      !["customScript", "database", "pickVars", "assert", "wait"].includes(
        task.type,
      )
    )
      throw Error("原版任务类型或启停标识无效");
    if (task.type === "customScript") {
      if (
        typeof task.data !== "string" ||
        (bytes += Buffer.byteLength(task.data)) > 65536
      )
        throw Error("任务脚本合计最多64KiB");
      if (task.enabled === 1) code.push("\n" + task.data + "\n");
    } else if (task.type === "wait") {
      const duration = normalizeNativeWaitData(task.data, {
        enabled: task.enabled === 1,
      });
      if (task.enabled === 1) {
        const index = nativeWaits.push(duration) - 1;
        code.push(
          `\n${duration > 0 ? "await " : ""}${waitPrefix}(${index});\n`,
        );
      }
    } else if (task.type === "assert") {
      const data = normalizeNativeAssertionData(task.data, {
        enabled: task.enabled === 1,
      });
      if (task.enabled === 1) {
        if (!input.response && !isNativeVariableAssertion(data.type))
          throw Error("启用响应断言仅支持后置响应阶段");
        const index =
          responseAssertions.push({
            name: task.name ?? "Native response assertion",
            data,
          }) - 1;
        code.push(`\n${assertPrefix}(${index});\n`);
      }
    } else if (task.type === "pickVars") {
      const data = normalizePickVarsData(task.data, {
        enabled: task.enabled === 1,
      });
      if (task.enabled === 1) {
        if (
          isNativeRequestPick(data.source)
            ? Boolean(input.response)
            : !input.response
        )
          throw Error("请求pickVars仅支持前置阶段，响应pickVars仅支持后置阶段");
        const index = responseExtractions.push(data) - 1;
        code.push(`\n${pickPrefix}(${index});\n`);
      }
    } else {
      const operation = normalizeDatabaseOperations([task.data])[0];
      if (task.enabled === 1) {
        const index = operations.push(operation) - 1;
        code.push(`\nawait ${prefix}(${index});\n`);
      }
    }
  }
  normalizeDatabaseOperations(operations);
  if (operations.length && typeof options.databaseQuery !== "function")
    throw Error("此执行入口未授权数据库任务");
  // One async lexical scope, including across awaited database boundaries.
  // Capture and remove the bridge before untrusted user code executes.
  const source =
    (operations.length
      ? `const ${prefix}=globalThis.__nativeDatabaseTask;delete globalThis.__nativeDatabaseTask;\n`
      : "") +
    (responseExtractions.length
      ? `const ${pickPrefix}=globalThis.__nativePickVarsTask;delete globalThis.__nativePickVarsTask;\n`
      : "") +
    (responseAssertions.length
      ? `const ${assertPrefix}=globalThis.__nativeAssertionTask;delete globalThis.__nativeAssertionTask;\n`
      : "") +
    (nativeWaits.length
      ? `const ${waitPrefix}=globalThis.__nativeWaitTask;delete globalThis.__nativeWaitTask;\n`
      : "") +
    code.join("");
  return runScript(source, input, {
    ...options,
    databaseOperations: operations,
    responseExtractions,
    responseAssertions,
    nativeWaits,
  }).catch((error) => {
    // Only the host coordinator can mint this policy marker. VM exceptions are
    // reconstructed from allowlisted text/diagnostics and cannot forge Symbols.
    if (responseExtractions.length)
      Object.defineProperty(error, extractionPhaseFailure, { value: true });
    throw error;
  });
}
