import { randomBytes } from "node:crypto";
import { normalizeDatabaseOperations } from "./script-database-tasks.mjs";
import { runScript } from "./scripts.mjs";

/** Backend primitive only. Import/project wiring is intentionally not enabled yet. */
export function runNativeTaskPhase(tasks, input, options = {}) {
  if (!Array.isArray(tasks) || tasks.length > 16)
    throw Error("原版任务阶段最多16项");
  const operations = [],
    code = [],
    prefix = "__db_" + randomBytes(16).toString("hex");
  let bytes = 0;
  for (const task of tasks) {
    if (
      !task ||
      typeof task !== "object" ||
      Array.isArray(task) ||
      ![1, 0, -1].includes(task.enabled) ||
      !["customScript", "database"].includes(task.type)
    )
      throw Error("原版任务类型或启停标识无效");
    if (task.type === "customScript") {
      if (
        typeof task.data !== "string" ||
        (bytes += Buffer.byteLength(task.data)) > 65536
      )
        throw Error("任务脚本合计最多64KiB");
      if (task.enabled === 1) code.push("\n" + task.data + "\n");
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
  const source = operations.length
    ? `const ${prefix}=globalThis.__nativeDatabaseTask;delete globalThis.__nativeDatabaseTask;\n` +
      code.join("")
    : code.join("");
  return runScript(source, input, {
    ...options,
    databaseOperations: operations,
  });
}
