import { folderScopePaths } from "./folder-scopes.js";
import { validateFolderParameters } from "./global-parameters.js";
function validateConfig(config) {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some(
      (key) => !["beforeScript", "afterScript", "enabled"].includes(key),
    )
  )
    throw Error("共享脚本配置无效");
  if (config.enabled !== undefined && typeof config.enabled !== "boolean")
    throw Error("脚本启用状态必须为布尔值");
  for (const field of ["beforeScript", "afterScript"])
    if (config[field] !== undefined && typeof config[field] !== "string")
      throw Error("脚本源码必须是文本");
  if (
    (config.beforeScript || "").length + (config.afterScript || "").length >
    100000
  )
    throw Error("共享脚本源码最多100000字符");
}
export function validateSharedScriptSettings(settings = {}) {
  folderScopePaths(settings);
  if (Object.hasOwn(settings, "globalScripts"))
    validateConfig(settings.globalScripts);
  if (settings.folderScripts !== undefined) {
    const folders = settings.folderScripts;
    if (!folders || typeof folders !== "object" || Array.isArray(folders))
      throw Error("目录脚本必须是对象");
    validateFolderParameters(
      Object.fromEntries(Object.keys(folders).map((name) => [name, {}])),
    );
    if (new TextEncoder().encode(JSON.stringify(folders)).length > 1024 * 1024)
      throw Error("目录脚本总计最多1MiB");
    for (const config of Object.values(folders)) validateConfig(config);
  }
}
export function scriptStages(request, phase) {
  const source = phase === "before" ? "beforeScript" : "afterScript";
  const shared =
    phase === "before" ? "sharedBeforeScripts" : "sharedAfterScripts";
  const stages = request[shared] ?? [];
  if (
    !Array.isArray(stages) ||
    stages.length > 33 ||
    stages.some(
      (item) =>
        !item ||
        typeof item.name !== "string" ||
        !item.name ||
        item.name.length > 200 ||
        typeof item.code !== "string" ||
        Object.keys(item).some((key) => !["name", "code"].includes(key)),
    )
  )
    throw Error("共享脚本阶段格式无效");
  if (request[source] !== undefined && typeof request[source] !== "string")
    throw Error("脚本源码必须是文本");
  const result = [
    ...stages,
    ...(request[source] ? [{ name: "request", code: request[source] }] : []),
  ];
  if (result.reduce((sum, item) => sum + item.code.length, 0) > 100000)
    throw Error("阶段源码合计最多100000字符");
  return result
    .filter(
      (item, index) =>
        item.code.trim() &&
        (request.inheritSharedScripts !== false || index >= stages.length),
    )
    .map((item) => ({ ...item }));
}
export function renameSharedScriptScopes(settings, previous, next) {
  validateSharedScriptSettings(settings);
  const folders = structuredClone(settings?.folderScripts || {});
  if (next === previous) return folders;
  if (next !== null && Object.hasOwn(folders, next))
    throw Error("目标目录脚本已存在");
  const config = Object.hasOwn(folders, previous)
    ? folders[previous]
    : undefined;
  delete folders[previous];
  if (next !== null && config)
    Object.defineProperty(folders, next, {
      value: config,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  validateSharedScriptSettings({ folderScripts: folders });
  return folders;
}
