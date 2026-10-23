const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const idOK = (value) =>
  typeof value === "string" && !!value && value.length <= 200;
export function validateCaseFolders(project) {
  const folders = project.caseFolders ?? [],
    cases = project.cases ?? [];
  if (
    !Array.isArray(folders) ||
    folders.length > 1000 ||
    !Array.isArray(cases) ||
    cases.length > 1000
  )
    throw Error("用例或分组最多1000项");
  const requests = new Set((project.requests || []).map((r) => r.id)),
    byId = new Map();
  for (const f of folders) {
    if (
      !f ||
      !idOK(f.id) ||
      byId.has(f.id) ||
      !idOK(f.sourceRequestId) ||
      !requests.has(f.sourceRequestId) ||
      typeof f.name !== "string" ||
      !f.name.trim() ||
      f.name.length > 200 ||
      (f.parentId !== undefined && typeof f.parentId !== "string") ||
      (f.sort !== undefined &&
        (!Number.isFinite(f.sort) || Math.abs(f.sort) > 1e9))
    )
      throw Error("用例分组定义或关联接口无效");
    byId.set(f.id, f);
  }
  for (const f of folders) {
    let parent = f.parentId || "";
    const seen = new Set([f.id]);
    while (parent) {
      if (seen.has(parent) || seen.size >= 20)
        throw Error("用例分组存在循环或超过20层");
      seen.add(parent);
      const a = byId.get(parent);
      if (!a || a.sourceRequestId !== f.sourceRequestId)
        throw Error("用例父分组不存在或跨接口");
      parent = a.parentId || "";
    }
  }
  for (const item of cases) {
    if (!item || typeof item !== "object") throw Error("用例格式无效");
    if (
      item.folderId !== undefined &&
      (typeof item.folderId !== "string" ||
        (item.folderId &&
          (!byId.has(item.folderId) ||
            byId.get(item.folderId).sourceRequestId !== item.sourceRequestId)))
    )
      throw Error("用例分组不存在或跨接口");
  }
  return folders;
}
export function saveCaseFolder(project, id, input, newId) {
  const folders = project.caseFolders || [],
    index = id === undefined ? -1 : folders.findIndex((f) => f.id === id);
  if (id !== undefined && index < 0) throw Error("用例分组不存在");
  const folder = {
    ...(index < 0 ? {} : folders[index]),
    id: id ?? newId,
    name: typeof input.name === "string" ? input.name.trim() : input.name,
    sourceRequestId: input.sourceRequestId,
    parentId: input.parentId ?? "",
  };
  const next = folders.slice();
  if (index < 0) next.push(folder);
  else next[index] = folder;
  validateCaseFolders({ ...project, caseFolders: next });
  project.caseFolders = next;
  return folder;
}
export function removeEmptyCaseFolder(project, id) {
  const folders = project.caseFolders || [];
  if (!folders.some((f) => f.id === id)) throw Error("用例分组不存在");
  if (
    folders.some((f) => f.parentId === id) ||
    (project.cases || []).some((c) => c.folderId === id)
  )
    throw Error("只能删除空用例分组，请先移动用例和子分组");
  const next = folders.filter((f) => f.id !== id);
  validateCaseFolders({ ...project, caseFolders: next });
  project.caseFolders = next;
}
export function caseFolderPath(folders, id) {
  const names = [],
    seen = new Set(),
    byId = new Map(folders.map((f) => [f.id, f]));
  while (id) {
    if (seen.has(id) || seen.size >= 20) throw Error("用例分组路径无效");
    seen.add(id);
    const f = byId.get(id);
    if (!f) throw Error("用例分组不存在");
    names.unshift(f.name);
    id = f.parentId || "";
  }
  return names.join(" / ");
}
export function caseCards(
  project,
  sourceRequestId,
  results = new Map(),
  busy = false,
  selected = new Set(),
  collapsedResults = new Set(),
) {
  const folders = validateCaseFolders(project).filter(
      (f) => f.sourceRequestId === sourceRequestId,
    ),
    cases = (project.cases || []).filter(
      (c) => c.sourceRequestId === sourceRequestId,
    );
  const ordered = (items) =>
    items
      .map((item, index) => ({ item, index }))
      .sort(
        (a, b) =>
          (a.item.sort ?? a.index) - (b.item.sort ?? b.index) ||
          a.index - b.index,
      )
      .map((x) => x.item);
  function group(id) {
    return (
      ordered(cases.filter((c) => (c.folderId || "") === id))
        .map(
          (c) =>
            `<div class="card"><div class="row"><input type="checkbox" data-select-case="${esc(c.id)}" aria-label="选择用例 ${esc(c.name)}" ${selected.has(c.id) ? "checked" : ""} ${busy ? "disabled" : ""}><strong class="grow">${esc(c.name)}</strong><button data-run-case="${esc(c.id)}" ${busy ? "disabled" : ""}>运行用例</button><button data-edit-case="${esc(c.id)}" ${busy ? "disabled" : ""}>编辑快照</button><button data-delete-case="${esc(c.id)}" class="danger" ${busy ? "disabled" : ""}>删除</button></div><p class="subtle">${esc(c.request.method)} ${esc(c.request.url)}</p>${results.has(c.id) ? (collapsedResults.has(c.id) ? `<details class="case-result" data-case-result="${esc(c.id)}"><summary>${results.get(c.id)?.outcome === "passed" ? "通过" : results.get(c.id)?.outcome === "error" ? "调用错误" : results.get(c.id)?.outcome === "not-run" ? "本批次未运行" : "未通过"} · ${results.get(c.id)?.status != null ? "HTTP " + esc(results.get(c.id).status) : results.get(c.id)?.outcome === "not-run" ? "未发送" : "未取得HTTP响应"}${results.get(c.id)?.evidenceTruncated ? " · 摘要" : ""}</summary><pre>${esc(JSON.stringify(results.get(c.id), null, 2))}</pre></details>` : `<pre>${esc(JSON.stringify(results.get(c.id), null, 2))}</pre>`) : ""}</div>`,
        )
        .join("") +
      ordered(folders.filter((f) => (f.parentId || "") === id))
        .map(
          (f) =>
            `<details class="model-folder" data-case-folder="${esc(f.id)}" open><summary><span>${esc(f.name)}</span><span class="model-folder-actions"><button data-edit-case-folder="${esc(f.id)}">编辑分组</button><button data-delete-case-folder="${esc(f.id)}" class="danger" ${folders.some((x) => x.parentId === f.id) || cases.some((c) => c.folderId === f.id) ? 'disabled title="只能删除空分组"' : ""}>删除空分组</button></span></summary><div class="model-folder-content">${group(f.id) || '<p class="muted">空用例分组</p>'}</div></details>`,
        )
        .join("")
    );
  }
  return (
    group("") ||
    '<div class="notice">尚无用例。可分别验证成功、参数缺失和认证失败等场景。</div>'
  );
}

export function caseRunOrder(project, sourceRequestId) {
  const folders = validateCaseFolders(project).filter(
    (f) => f.sourceRequestId === sourceRequestId,
  );
  const cases = (project.cases || []).filter(
    (c) => c.sourceRequestId === sourceRequestId,
  );
  const ordered = (values) =>
    values
      .map((item, index) => ({ item, index }))
      .sort(
        (a, b) =>
          (a.item.sort ?? a.index) - (b.item.sort ?? b.index) ||
          a.index - b.index,
      )
      .map((x) => x.item);
  const group = (id) => [
    ...ordered(cases.filter((c) => (c.folderId || "") === id)),
    ...ordered(folders.filter((f) => (f.parentId || "") === id)).flatMap((f) =>
      group(f.id),
    ),
  ];
  return group("");
}
