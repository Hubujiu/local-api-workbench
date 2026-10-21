export function folderScopePaths(settings = {}, path = "") {
  if (
    settings.recursiveFolderScopes !== undefined &&
    typeof settings.recursiveFolderScopes !== "boolean"
  )
    throw Error("递归目录继承开关必须为布尔值");
  if (!path) return [];
  if (settings.recursiveFolderScopes !== true) return [path];
  const parts = path.split("/");
  if (
    parts.length > 32 ||
    parts.some(
      (x) =>
        !x.trim() ||
        [".", "..", "__proto__", "prototype", "constructor"].includes(x),
    )
  )
    throw Error("递归目录路径无效（最多32层）");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
