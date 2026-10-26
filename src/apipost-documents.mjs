import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  validateResourceJSON,
  validateResourceFolder,
  validateResourceDocument,
  validateAPIResourceTrash,
} from "./api-resource-lifecycle.mjs";

// Interface mapping only: the native document body is top-level description.
// No Markdown rendering, attachment fetching, interpolation or task execution.
export function importApipostDocument(node, folder, sourceProjectId) {
  validateResourceJSON(node, 1024 * 1024);
  const fields = [
    "target_id",
    "target_type",
    "project_id",
    "parent_id",
    "name",
    "description",
    "sort",
    "version",
    "mark_id",
    "status",
    "request",
    "response",
    "method",
    "url",
  ];
  if (
    Object.keys(node).some((key) => !fields.includes(key)) ||
    node.target_type !== "doc"
  )
    throw Error("Apipost文档含尚未支持字段，不会丢弃来源");
  for (const key of ["target_id", "name"])
    if (
      typeof node[key] !== "string" ||
      !node[key].trim() ||
      node[key].length > 200
    )
      throw Error("Apipost文档标识或名称无效");
  for (const key of ["project_id", "parent_id", "mark_id"])
    if (
      node[key] !== undefined &&
      (typeof node[key] !== "string" || node[key].length > 200)
    )
      throw Error("Apipost文档来源标识无效");
  if (
    sourceProjectId !== undefined &&
    node.project_id !== undefined &&
    sourceProjectId !== node.project_id
  )
    throw Error("Apipost文档项目来源不匹配");
  for (const key of ["sort", "version", "status"])
    if (
      node[key] !== undefined &&
      (!Number.isSafeInteger(node[key]) || node[key] < 0)
    )
      throw Error("Apipost文档排序或版本状态无效");
  for (const key of ["request", "response"])
    if (
      node[key] !== undefined &&
      (!node[key] ||
        typeof node[key] !== "object" ||
        Array.isArray(node[key]) ||
        Object.keys(node[key]).length)
    )
      throw Error("Apipost文档不能携带请求、响应或任务配置");
  for (const key of ["method", "url"])
    if (node[key] !== undefined && node[key] !== "")
      throw Error("Apipost文档不能携带HTTP方法或URL");
  if (folder) validateResourceFolder(folder);
  const source = {
    ...(sourceProjectId !== undefined || node.project_id !== undefined
      ? { projectId: sourceProjectId ?? node.project_id }
      : {}),
    targetId: node.target_id,
    parentId: node.parent_id ?? "0",
    ...Object.fromEntries(
      ["sort", "version", "mark_id", "status"]
        .filter((key) => node[key] !== undefined)
        .map((key) => [key, node[key]]),
    ),
  };
  const result = {
    id:
      "apipost-doc-" +
      createHash("sha256")
        .update(JSON.stringify([source.projectId ?? null, node.target_id]))
        .digest("hex")
        .slice(0, 32),
    title: node.name,
    content: node.description === undefined ? "" : node.description,
    folder,
    apipostSource: source,
    importNotes: [
      "原生文档仅按静态doc/description字段映射；正文原样保留，不执行模板、脚本或读取附件。未验证原版GUI往返。",
    ],
  };
  validateResourceDocument(result);
  return result;
}

export function mergeImportedDocuments(
  project,
  incoming = [],
  { sync = false } = {},
) {
  if (!incoming.length) return undefined;
  if (sync) throw Error("原生文档暂不支持同步覆盖，请完整导入");
  validateAPIResourceTrash(project);
  const result = structuredClone(project.documents || []);
  const occupied = new Set([
    ...(project.requests || []).map((item) => item.id),
    ...(project.protocols || []).map((item) => item.id),
    ...(project.settings?.socketioDefinitions || []).map((item) => item.id),
    ...(project.settings?.grpcDefinitions || []).map((item) => item.id),
    ...(project.apiResourceTrash?.batches || []).flatMap((batch) =>
      batch.documents.map((item) => item.id),
    ),
    ...(project.apiResourceTrash?.batches || []).flatMap(
      (batch) => batch.requestIds,
    ),
  ]);
  const seen = new Set();
  for (const document of incoming) {
    validateResourceDocument(document);
    if (seen.has(document.id) || occupied.has(document.id))
      throw Error("Apipost文档ID冲突（含回收资源），请导入新项目");
    seen.add(document.id);
    const previous = result.filter((item) => item.id === document.id);
    if (
      previous.length > 1 ||
      (previous.length && !isDeepStrictEqual(previous[0], document))
    )
      throw Error("Apipost文档来源冲突，请导入新项目");
    if (!previous.length) result.push(structuredClone(document));
  }
  if (result.length > 5000) throw Error("项目文档最多5000条");
  validateResourceJSON(result);
  return result;
}
