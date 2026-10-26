import { normalizeNativeTaskRequest } from "./script-database-tasks.mjs";
import { nativeDataObject } from "./native-response-extraction.mjs";

// Independently written format adapter. Never compile source or activate inert
// provenance. The executable pipeline, not an old script-source mirror, wins.
export function exportApipostTaskPipeline(request) {
  if (request.nativeTasks === undefined) return undefined;
  nativeDataObject(request.nativeTasks, ["version", "before", "after"]);
  const pipeline = normalizeNativeTaskRequest(request);
  if (request.scriptDialect !== "apipost8")
    throw Error("Apipost导出nativeTasks须使用Apipost脚本方言；请使用项目备份");
  if (
    request.importedScriptTasks !== undefined ||
    request.importedNativeTaskSource !== undefined
  )
    throw Error(
      "Apipost导出nativeTasks不能同时保留惰性任务来源；请使用项目备份",
    );
  const all = [...pipeline.before, ...pipeline.after];
  for (const task of all) {
    if (
      !["customScript", "pickVars", "assert", "wait"].includes(task.type) ||
      task.origin !== undefined
    )
      throw Error(
        "Apipost导出nativeTasks仅支持接口本地非数据库任务；请使用项目备份",
      );
    if (!task.id || !task.name)
      throw Error(
        "Apipost导出nativeTasks须保留明确任务ID和名称；请使用项目备份",
      );
  }
  // Native import classifies all-script/empty lists as legacy script sources.
  // Do not silently switch canonical execution models or synthesize a marker.
  if (!all.some((task) => task.type !== "customScript"))
    throw Error(
      "Apipost导出nativeTasks暂不转换纯脚本或空执行管线；请使用项目备份",
    );
  return pipeline;
}
