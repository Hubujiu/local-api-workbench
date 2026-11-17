import {
  executionRecords,
  isExecutionArchivePath,
} from "./apipost-execution-files.mjs";
// Known original catalogs and execution records are retained as source data,
// never executed or counted as fresh Workbench runs. Unknown files reject.
function dataArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++)
    if (!descriptors[i]?.enumerable || !Object.hasOwn(descriptors[i], "value"))
      return false;
  return true;
}
export const directoryArtifactPath = "settings/mock_inner_rules.json";
export function normalizeDirectoryArtifacts(value = []) {
  if (!dataArray(value) || value.length > 20)
    throw Error("原版目录来源记录最多20项");
  let bytes = 0;
  const ids = new Set();
  const plain = (x, keys) => {
    if (
      !x ||
      typeof x !== "object" ||
      Array.isArray(x) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(x))
    )
      throw Error("原版目录来源记录无效");
    const descriptors = Object.getOwnPropertyDescriptors(x);
    if (
      Reflect.ownKeys(x).some(
        (k) =>
          typeof k !== "string" ||
          !keys.includes(k) ||
          !descriptors[k].enumerable ||
          !Object.hasOwn(descriptors[k], "value"),
      )
    )
      throw Error("原版目录来源字段无效");
  };
  return value.map((entry) => {
    plain(entry, ["sourceProjectId", "files"]);
    const sourceProjectId = entry.sourceProjectId;
    if (
      typeof sourceProjectId !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(sourceProjectId) ||
      ids.has(sourceProjectId) ||
      ["__proto__", "constructor", "prototype"].includes(sourceProjectId)
    )
      throw Error("原版目录来源项目标识无效或重复");
    ids.add(sourceProjectId);
    if (
      !dataArray(entry.files) ||
      !entry.files.length ||
      entry.files.length > 52
    )
      throw Error("原版目录仅保留有界的已知规则或执行记录文件");
    const parsedFiles = new Map();
    const files = entry.files.map((file) => {
      plain(file, ["path", "text"]);
      if (
        (file.path !== directoryArtifactPath &&
          !isExecutionArchivePath(file.path)) ||
        typeof file.text !== "string"
      )
        throw Error("原版目录来源路径或内容无效");
      bytes +=
        Buffer.byteLength(file.text, "utf8") +
        file.path.length +
        sourceProjectId.length;
      if (bytes > 4 * 1024 * 1024) throw Error("原版目录保留文件合计最多4MiB");
      let parsed;
      try {
        parsed = JSON.parse(file.text);
      } catch {
        throw Error("原版目录保留文件JSON无效");
      }
      if (parsedFiles.has(file.path)) throw Error("原版目录来源路径重复");
      parsedFiles.set(file.path, parsed);
      if (
        file.path === directoryArtifactPath &&
        (!Array.isArray(parsed) || parsed.length > 5000)
      )
        throw Error("原版目录内置规则须为有界数组");
      return { path: file.path, text: file.text };
    });
    executionRecords(parsedFiles, "runs", sourceProjectId);
    return { sourceProjectId, files };
  });
}
export function mergeDirectoryArtifacts(previous, document, sourceProjectId) {
  const result = normalizeDirectoryArtifacts(previous);
  const files = document.files.filter(
    (f) => f.path === directoryArtifactPath || isExecutionArchivePath(f.path),
  );
  if (!files.length) return result;
  return normalizeDirectoryArtifacts([
    ...result.filter((entry) => entry.sourceProjectId !== sourceProjectId),
    {
      sourceProjectId,
      files: files.map((file) => ({ path: file.path, text: file.text })),
    },
  ]);
}
