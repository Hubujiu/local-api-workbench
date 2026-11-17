const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const scopedExportFormats = {
  apipost: "Apipost JSON（受支持定义子集）",
  "apipost-directory": "Apipost 目录 JSON 清单（不是 ZIP）",
  "postman-collection-v2.1": "Postman Collection 2.1（仅请求定义）",
};
const labels = {
  api: "接口",
  folder: "接口/文档目录（整个子树）",
  document: "文档",
  case: "用例",
  "case-folder": "用例目录",
  model: "模型",
  "model-folder": "模型目录",
  environment: "环境",
  globals: "全局配置（整体）",
  "protocol-bundle": "协议定义（整体）",
  "collection-bundle": "集合注册信息（整体）",
};
const key = (item) => JSON.stringify([item.kind, item.id]);
export function scopedExportResources(project) {
  const output = [],
    seen = new Set(),
    folders = new Set();
  const add = (kind, id, name) => {
    if (typeof id !== "string" || !id || seen.has(key({ kind, id }))) return;
    seen.add(key({ kind, id }));
    output.push({ kind, id, name: String(name || id) });
  };
  const folder = (path) => {
    if (typeof path !== "string") return;
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (p) folders.add(p);
    }
  };
  for (const path of project.folders || []) folder(path);
  for (const [field, kind] of Object.entries({
    requests: "api",
    documents: "document",
    cases: "case",
    caseFolders: "case-folder",
    dictionary: "model",
    modelFolders: "model-folder",
    environments: "environment",
  }))
    for (const row of project[field] || []) {
      if (row.deletedAt) continue;
      add(kind, row.id, row.name || row.title);
      if (kind === "api" || kind === "document") folder(row.folder);
    }
  for (const path of [...folders].sort()) add("folder", path, path);
  const knownModels = new Set((project.dictionary || []).map((row) => row.id));
  for (const id of Object.keys(project.openapiComponents?.schemas || {}))
    if (!knownModels.has(id)) add("model", id, id);
  add("globals", "configuration", "全局变量、共享设置等（可能包含敏感信息）");
  if (
    [
      project.protocols,
      project.settings?.socketioDefinitions,
      project.settings?.grpcDefinitions,
      project.settings?.apipostProtocolSources,
    ].some((rows) => rows?.length)
  )
    add("protocol-bundle", "definitions", "全部协议定义及来源绑定");
  if (project.postmanCollections !== undefined)
    add("collection-bundle", "registry", "集合注册信息");
  if (output.length > 10000) throw Error("资源超过选择上限，请拆分项目后导出");
  return output;
}
export function scopedExportSelectionHTML(resources) {
  return `<p>只导出已保存的所选定义，不是完整备份；不包含执行记录、历史版本、回收站或执行计划。未保存修改请先保存，再重新打开。</p><label>格式<select id="scoped-export-format">${Object.entries(
    scopedExportFormats,
  )
    .map(([id, name]) => `<option value="${id}">${esc(name)}</option>`)
    .join(
      "",
    )}</select></label><p class="notice">文件不是脱敏文件：认证、URL、Header、脚本、请求体、示例及变量可能包含秘密。预览将列出必需依赖，下载前必须明确确认。Postman 仅支持接口/目录，不含环境和全局变量值，不能保证独立重放。无法保真的配置会明确拒绝。</p><label><input id="scoped-export-rebind" type="checkbox">允许数据库定义仅保留重绑定信息（不包含运行时授权；仅原生格式）</label><fieldset id="scoped-export-resources"><legend>选择资源（默认全不选）</legend>${resources.map((r, i) => `<label style="display:block"><input type="checkbox" data-export-resource="${i}" data-kind="${esc(r.kind)}" data-id="${esc(r.id)}">${esc(labels[r.kind])} · ${esc(r.name)} <small>${esc(r.id)}</small></label>`).join("")}</fieldset>`;
}
export function readScopedExportInput(root, resources) {
  const format = root.querySelector("#scoped-export-format").value;
  if (!Object.hasOwn(scopedExportFormats, format)) throw Error("导出格式无效");
  const selected = Array.from(
    root.querySelectorAll("[data-export-resource]:checked"),
    (el) => resources[Number(el.dataset.exportResource)],
  );
  if (!selected.length || selected.some((r) => !r))
    throw Error("请明确选择至少一个资源；不会默认导出整个项目");
  if (
    format === "postman-collection-v2.1" &&
    selected.some((r) => !["api", "folder"].includes(r.kind))
  )
    throw Error("Postman 集合仅支持选择接口或目录");
  const rebind = root.querySelector("#scoped-export-rebind").checked;
  if (rebind && format === "postman-collection-v2.1")
    throw Error("Postman 格式不支持数据库重绑定选项，请取消勾选");
  return {
    format,
    selection: {
      mode: "explicit",
      resources: selected.map(({ kind, id }) => ({ kind, id })),
    },
    ...(rebind ? { databaseMode: "rebind" } : {}),
  };
}
function identities(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length > 10000 ||
    rows.some(
      (r) =>
        !r ||
        typeof r.kind !== "string" ||
        typeof r.id !== "string" ||
        !r.id ||
        !Object.hasOwn(labels, r.kind),
    )
  )
    throw Error("导出范围回执无效");
  const keys = rows.map(key);
  if (new Set(keys).size !== keys.length) throw Error("导出范围回执含重复身份");
  return keys.sort();
}
export function assertScopedExportPreview(preview, input, project) {
  if (
    !preview ||
    preview.projectId !== project.id ||
    preview.format !== input.format ||
    preview.configRevision !== project.configRevision ||
    !Number.isSafeInteger(preview.configRevision) ||
    preview.configRevision < 0 ||
    !Number.isSafeInteger(preview.documentBytes) ||
    preview.documentBytes < 0 ||
    preview.documentBytes > 4 * 1024 * 1024 ||
    !Array.isArray(preview.warnings) ||
    !preview.warnings.length ||
    preview.warnings.some((w) => typeof w !== "string" || w.length > 16000) ||
    Object.hasOwn(preview, "document") ||
    !/^[a-f0-9]{64}$/.test(preview.scope?.digest || "")
  )
    throw Error("导出预览回执不完整或项目版本不匹配");
  if (
    preview.options?.modelNameMode !== (input.modelNameMode || "namespaced") ||
    preview.options?.databaseMode !== (input.databaseMode || null)
  )
    throw Error("预览格式选项不匹配");
  if (input.format === "postman-collection-v2.1") {
    const omitted = preview.omittedConfiguration;
    if (
      !omitted ||
      omitted.independentlyReplayable !== false ||
      typeof omitted.globalVariables !== "boolean" ||
      !Array.isArray(omitted.environments) ||
      omitted.environments.some((r) => r?.kind !== "environment")
    )
      throw Error("Postman 省略配置回执不完整");
    identities(omitted.environments);
  } else if (preview.omittedConfiguration !== undefined) {
    throw Error("当前格式返回了未知省略配置");
  }
  if (
    JSON.stringify(identities(preview.scope.requested)) !==
    JSON.stringify(identities(input.selection.resources))
  )
    throw Error("预览选择范围不匹配");
  const included = identities(preview.scope.included),
    dependencies = identities(preview.scope.dependencies),
    requested = identities(preview.scope.requested);
  if (
    requested.some((k) => !included.includes(k)) ||
    JSON.stringify(included.filter((k) => !requested.includes(k))) !==
      JSON.stringify(dependencies)
  )
    throw Error("预览依赖范围不匹配");
  if (
    !Array.isArray(preview.scope.omitted) ||
    preview.scope.omitted.some((x) => typeof x !== "string")
  )
    throw Error("导出遗漏范围回执无效");
  return preview;
}
export function scopedExportConfirmationHTML(preview, resources) {
  const names = new Map(resources.map((r) => [key(r), r.name]));
  const rows = (items) =>
    items
      .map(
        (r) =>
          `<li>${esc(labels[r.kind])} · ${esc(names.get(key(r)) || r.id)} <small>${esc(r.id)}</small></li>`,
      )
      .join("");
  return `<p>格式：${esc(scopedExportFormats[preview.format])}；约 ${preview.documentBytes} 字节。所列是定义依赖范围，格式可能省略部分配置，以以下服务端警告为准。</p><h3>你选择的资源</h3><ul>${rows(preview.scope.requested)}</ul><h3>必须一起接受的依赖（${preview.scope.dependencies.length}）</h3>${preview.scope.dependencies.length ? `<ul>${rows(preview.scope.dependencies)}</ul>` : "<p>无额外资源依赖。</p>"}<h3>最终范围（${preview.scope.included.length}）</h3><ul>${rows(preview.scope.included)}</ul><div id="scoped-export-warnings" class="notice">${preview.warnings.map((w) => `<p>${esc(w)}</p>`).join("")}</div>${preview.omittedConfiguration ? `<h3>Postman 未写入的配置</h3><p>全局变量值：${preview.omittedConfiguration.globalVariables ? "存在，但不导出" : "无"}；环境值：${preview.omittedConfiguration.environments.length ? "以下环境不导出" : "无"}。占位符未解析，不能保证独立重放。</p><ul>${rows(preview.omittedConfiguration.environments)}</ul>` : ""}<p>未包含：${preview.scope.omitted.map(esc).join("、")}。</p><label><input id="scoped-export-accept" type="checkbox">我已核对完整范围、必需依赖及上述警告，接受可能含敏感信息的非脱敏文件</label>`;
}
export function scopedExportRequest(input, preview) {
  return {
    ...input,
    configRevision: preview.configRevision,
    scopeDigest: preview.scope.digest,
    acceptedDependencies: preview.scope.dependencies.map(({ kind, id }) => ({
      kind,
      id,
    })),
  };
}
export function assertScopedExportResult(result, preview) {
  if (
    !result ||
    !Object.hasOwn(result, "document") ||
    result.document === null ||
    typeof result.document !== "object" ||
    ["projectId", "format", "configRevision", "documentBytes"].some(
      (k) => result[k] !== preview[k],
    ) ||
    JSON.stringify(result.scope) !== JSON.stringify(preview.scope) ||
    JSON.stringify(result.warnings) !== JSON.stringify(preview.warnings) ||
    JSON.stringify(result.options) !== JSON.stringify(preview.options) ||
    JSON.stringify(result.omittedConfiguration) !==
      JSON.stringify(preview.omittedConfiguration)
  )
    throw Error("导出结果与已确认的预览不一致；未触发下载，请重新预览");
  if (
    new TextEncoder().encode(JSON.stringify(result.document)).byteLength !==
    preview.documentBytes
  )
    throw Error("导出文档大小与预览不匹配；未触发下载");
  return result.document;
}
