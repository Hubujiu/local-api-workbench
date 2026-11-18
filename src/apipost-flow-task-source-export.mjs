import { isDeepStrictEqual } from "node:util";
import { normalizeImportedNativeTaskSource } from "./imported-native-task-source.mjs";
import { exportApipostTaskPipeline } from "./apipost-task-export.mjs";

export function exportFrozenTaskSource(request) {
  for (const key of ["importedNativeTaskSource", "importedScriptTasks", "id"]) {
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (
      (descriptor &&
        (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))) ||
      (!descriptor && key in request)
    )
      throw Error("原生目录任务来源不接受访问器、隐藏字段或继承属性");
  }
  if (request.importedNativeTaskSource === undefined) return undefined;
  if (request.importedScriptTasks !== undefined)
    throw Error("原生目录不能合并两种惰性任务来源；请使用项目备份");
  const source = normalizeImportedNativeTaskSource(
    request.importedNativeTaskSource,
  );
  for (const task of [...source.before, ...source.after])
    if (task.type === "database" || task.origin !== undefined)
      throw Error("原生目录任务来源暂不支持数据库或继承作用域；请使用项目备份");
  const result = exportApipostTaskPipeline({
    id: request.id,
    nativeTasks: source,
    scriptDialect: "apipost8",
    inheritSharedScripts: false,
  });
  if (!isDeepStrictEqual(result, source))
    throw Error("原生目录任务来源转换不一致；请使用项目备份");
  return result;
}

export function verifyFrozenTaskSource(expected, actual) {
  if (!isDeepStrictEqual(expected, actual))
    throw Error("原生目录步骤惰性任务来源回读不一致");
}
