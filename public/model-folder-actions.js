import { validateModelFolders } from "./model-folders.js";
export function saveModelFolder(project, id, input, newId) {
  const folders = project.modelFolders || [];
  const index =
    id === undefined ? -1 : folders.findIndex((folder) => folder.id === id);
  if (id !== undefined && index < 0) throw Error("模型目录不存在");
  const folderId = id ?? newId;
  if (
    typeof folderId !== "string" ||
    !folderId ||
    folders.some((folder, i) => i !== index && folder.id === folderId)
  )
    throw Error("模型目录ID无效或重复");
  const folder = {
    ...(index < 0 ? {} : folders[index]),
    id: folderId,
    name: typeof input.name === "string" ? input.name.trim() : input.name,
    parentId: input.parentId ?? "",
    description: input.description ?? "",
  };
  const next = folders.slice();
  if (index < 0) next.push(folder);
  else next[index] = folder;
  validateModelFolders({ ...project, modelFolders: next });
  project.modelFolders = next;
  return folder;
}
export function removeEmptyModelFolder(project, id) {
  const folders = project.modelFolders || [];
  if (!folders.some((folder) => folder.id === id))
    throw Error("模型目录不存在");
  if (
    folders.some((folder) => folder.parentId === id) ||
    (project.dictionary || []).some((model) => model.folderId === id)
  )
    throw Error("只能删除空模型目录，请先移动模型和子目录");
  const next = folders.filter((folder) => folder.id !== id);
  validateModelFolders({ ...project, modelFolders: next });
  project.modelFolders = next;
}
