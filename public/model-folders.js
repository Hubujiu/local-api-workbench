const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function validateModelFolders(project) {
  const folders = project.modelFolders ?? [];
  if (!Array.isArray(folders) || folders.length > 1000)
    throw Error("模型目录最多1000项");
  const byId = new Map();
  for (const folder of folders) {
    if (
      !folder ||
      typeof folder.id !== "string" ||
      !folder.id ||
      folder.id.length > 200 ||
      byId.has(folder.id) ||
      typeof folder.name !== "string" ||
      !folder.name.trim() ||
      folder.name.length > 200 ||
      (folder.parentId !== undefined && typeof folder.parentId !== "string") ||
      (folder.description !== undefined &&
        (typeof folder.description !== "string" ||
          folder.description.length > 5000)) ||
      (folder.sort !== undefined &&
        (typeof folder.sort !== "number" || !Number.isFinite(folder.sort)))
    )
      throw Error("模型目录定义无效或ID重复");
    byId.set(folder.id, folder);
  }
  for (const folder of folders) {
    let parent = folder.parentId || "",
      depth = 0;
    const seen = new Set([folder.id]);
    while (parent) {
      if (seen.has(parent)) throw Error("模型目录存在循环");
      seen.add(parent);
      if (++depth >= 20) throw Error("模型目录最多20层");
      const ancestor = byId.get(parent);
      if (!ancestor) throw Error("模型父目录不存在");
      parent = ancestor.parentId || "";
    }
  }
  if (!Array.isArray(project.dictionary ?? []))
    throw Error("数据模型 dictionary 必须为数组");
  for (const model of project.dictionary || []) {
    if (!model || typeof model !== "object" || Array.isArray(model))
      throw Error("数据模型格式无效");
    if (
      model.folderId !== undefined &&
      (typeof model.folderId !== "string" ||
        (model.folderId && !byId.has(model.folderId)))
    )
      throw Error("数据模型引用了不存在的目录");
  }
  return folders;
}
export function modelCards(project) {
  const folders = validateModelFolders(project);
  const models = (project.dictionary || []).map((model, index) => ({
    model,
    index,
  }));
  const ordered = (items, get) =>
    items
      .map((item, index) => ({ item, index }))
      .sort(
        (a, b) =>
          (get(a.item) ?? a.index) - (get(b.item) ?? b.index) ||
          a.index - b.index,
      )
      .map((x) => x.item);
  function group(parentId) {
    const cards = ordered(
      models.filter(({ model }) => (model.folderId || "") === parentId),
      ({ model }) => model.sort,
    )
      .map(
        ({ model, index }) =>
          `<div class="card"><div class="row"><strong class="grow">${esc(model.name)}</strong><button data-edit-dictionary="${index}">编辑</button><button data-use-dictionary="${index}">应用到当前接口</button></div><pre>${esc(JSON.stringify(model.schema, null, 2))}</pre></div>`,
      )
      .join("");
    const children = ordered(
      folders.filter((folder) => (folder.parentId || "") === parentId),
      (folder) => folder.sort,
    )
      .map(
        (folder) =>
          `<details class="model-folder" data-model-folder="${esc(folder.id)}" open><summary>${esc(folder.name)}</summary>${folder.description ? `<p class="muted">${esc(folder.description)}</p>` : ""}<div class="model-folder-content">${group(folder.id) || '<p class="muted">空模型目录</p>'}</div></details>`,
      )
      .join("");
    return cards + children;
  }
  return group("") || '<div class="empty"><p>暂无数据模型</p></div>';
}
