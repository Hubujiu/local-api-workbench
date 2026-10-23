import { validateCaseFolders } from "./case-folders.js";
function selected(project, sourceRequestId, ids) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 1000 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== "string" || !id)
  )
    throw Error("请选中1至1000个不同的接口用例");
  const result = new Set(ids);
  for (const id of result) {
    const matches = (project.cases || []).filter((c) => c.id === id);
    if (matches.length !== 1 || matches[0].sourceRequestId !== sourceRequestId)
      throw Error("选中用例不存在或不属于当前接口");
  }
  return result;
}
export function moveSelectedCases(project, sourceRequestId, ids, folderId) {
  const chosen = selected(project, sourceRequestId, ids);
  if (typeof folderId !== "string") throw Error("目标用例分组无效");
  const next = (project.cases || []).map((c) =>
    chosen.has(c.id) ? { ...c, folderId } : c,
  );
  validateCaseFolders({ ...project, cases: next });
  project.cases = next;
}
export function deleteSelectedCases(project, sourceRequestId, ids) {
  const chosen = selected(project, sourceRequestId, ids),
    next = (project.cases || []).filter((c) => !chosen.has(c.id));
  validateCaseFolders({ ...project, cases: next });
  project.cases = next;
}
