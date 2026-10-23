import {
  descriptionRecord,
  descriptionList,
  validateParameterDescriptions,
} from "../public/parameter-descriptions.js";
export function mergeApipostDescriptions(rows = [], existing = [], projectId) {
  if (!Array.isArray(rows) || rows.length > 2000)
    throw Error("Apipost参数说明库最多2000条");
  descriptionList(rows);
  const ids = new Set();
  const incoming = rows.map((row) => {
    descriptionRecord(row, ["id", "project_id", "key", "description"]);
    if (row.project_id !== undefined && row.project_id !== projectId)
      throw Error("Apipost参数说明项目来源不匹配");
    if (row.id !== undefined) {
      if (ids.has(row.id)) throw Error("Apipost参数说明来源标识重复");
      ids.add(row.id);
    }
    return {
      key: row.key,
      description: row.description === undefined ? "" : row.description,
      ...(row.id !== undefined || row.project_id !== undefined
        ? {
            apipostSource: {
              projectId,
              ...(row.id !== undefined ? { id: row.id } : {}),
            },
          }
        : {}),
    };
  });
  validateParameterDescriptions(incoming);
  validateParameterDescriptions(existing);
  const result = structuredClone(existing),
    byKey = new Map(result.map((entry) => [entry.key, entry]));
  for (const entry of incoming) {
    const previous = byKey.get(entry.key);
    if (previous && previous.description !== entry.description)
      throw Error("Apipost参数说明同名冲突，请导入新项目");
    if (!previous) {
      result.push(entry);
      byKey.set(entry.key, entry);
    }
  }
  return validateParameterDescriptions(result);
}
