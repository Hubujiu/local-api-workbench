import { isDeepStrictEqual } from "node:util";
import {
  validateResourceJSON,
  validateResourceDocument,
} from "./api-resource-lifecycle.mjs";
import { importApipostDocument } from "./apipost-documents.mjs";

const sourceKeys = [
  "projectId",
  "targetId",
  "parentId",
  "sort",
  "version",
  "mark_id",
  "status",
];
const nativeNote =
  "原生文档仅按静态doc/description字段映射；正文原样保留，不执行模板、脚本或读取附件。未验证原版GUI往返。";

// Definition conversion only. Original identity is historical backup data, not
// an executable link or a private extension inserted into the exported body.
export function exportApipostDocuments(project, { projectId, id, folder }) {
  const documents = project.documents ?? [];
  validateResourceJSON(documents);
  if (!Array.isArray(documents) || documents.length > 5000)
    throw Error("原生文档导出列表无效或超过5000条");
  const occupied = new Set((project.requests || []).map((r) => r.id));
  const statuses = new Set((project.settings?.statuses || []).map((s) => s.id));
  return documents.map((doc) => {
    validateResourceDocument(doc);
    if (occupied.has(doc.id)) throw Error("原生文档导出ID冲突");
    occupied.add(doc.id);
    if (Object.hasOwn(doc, "deletedAt"))
      throw Error("原生文档删除档案请使用项目备份");
    if (doc.attributes && Object.keys(doc.attributes).length)
      throw Error("原生文档属性尚不能无损导出，请使用项目备份");
    if (
      doc.importNotes?.length &&
      !isDeepStrictEqual(doc.importNotes, [nativeNote])
    )
      throw Error("原生文档自定义说明请使用项目备份");
    const source = doc.apipostSource || {};
    if (Object.keys(source).some((key) => !sourceKeys.includes(key)))
      throw Error("原生文档未知来源字段请使用项目备份");
    // Validate historical source shape without reviving its old parent/mark IDs.
    if (doc.apipostSource) {
      importApipostDocument(
        {
          target_type: "doc",
          target_id: source.targetId,
          name: doc.title,
          description: doc.content,
          ...(source.projectId !== undefined
            ? { project_id: source.projectId }
            : {}),
          ...(source.parentId !== undefined
            ? { parent_id: source.parentId }
            : {}),
          ...Object.fromEntries(
            ["sort", "version", "mark_id", "status"]
              .filter((k) => source[k] !== undefined)
              .map((k) => [k, source[k]]),
          ),
        },
        doc.folder || "",
        source.projectId,
      );
    }
    if (doc.statusId && !statuses.has(doc.statusId))
      throw Error("原生文档当前状态引用不存在");
    if (source.mark_id && !doc.statusId)
      throw Error("原生文档旧状态来源无法映射，请使用项目备份");
    const node = {
      target_id: id("d", doc.id),
      project_id: projectId,
      parent_id: folder(doc.folder || ""),
      target_type: "doc",
      name: doc.title,
      description: doc.content,
      ...Object.fromEntries(
        ["sort", "version", "status"]
          .filter((k) => source[k] !== undefined)
          .map((k) => [k, source[k]]),
      ),
      ...(doc.statusId ? { mark_id: id("m", doc.statusId) } : {}),
    };
    const check = importApipostDocument(node, doc.folder || "", projectId);
    if (
      check.title !== doc.title ||
      check.content !== doc.content ||
      check.folder !== (doc.folder || "")
    )
      throw Error("原生文档导出回读不一致");
    return node;
  });
}

export function verifyApipostDocumentDefinitions(expected, actual) {
  const project = (nodes) =>
    nodes.map((node) => ({
      title: node.title,
      content: node.content,
      folder: node.folder || "",
      statusName: node.statusName,
      ...Object.fromEntries(
        ["sort", "version", "status"]
          .filter((k) => node.apipostSource?.[k] !== undefined)
          .map((k) => [k, node.apipostSource[k]]),
      ),
    }));
  if (!isDeepStrictEqual(project(expected), project(actual)))
    throw Error("原生文档定义回读不一致");
}
