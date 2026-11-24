const countKinds = {
  create: "created",
  update: "updated",
  reuse: "reused",
  skip: "skipped",
  trash: "trashed",
};
const kindLabels = {
  api: "接口",
  model: "数据模型",
  folder: "目录",
  environment: "环境",
};
const actionLabels = {
  create: "新增",
  reuse: "复用",
  update: "更新",
  skip: "跳过",
  trash: "移除",
  block: "冲突",
};
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
const MAX_FILE = 1024 * 1024;

export async function readOpenAPIReviewInput(file) {
  if (
    !/\.(json|ya?ml)$/i.test(file.name) ||
    file.size < 1 ||
    file.size > MAX_FILE
  )
    throw Error(
      "请选择不超过 1 MiB 的本地 Swagger / OpenAPI JSON 或 YAML 文件",
    );
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size)
    throw Error("文件读取结果已变化，请重新选择");
  const document = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  return Object.freeze({
    format: "openapi",
    document,
    selection: Object.freeze({ mode: "all" }),
  });
}

export function assertOpenAPIReview(preview, revision, excluded) {
  const receiptInvalid = () => {
    throw Error("预览回执无效或项目版本已变化，请重新加载后预览");
  };
  if (
    preview?.version !== 1 ||
    preview.configRevision !== revision ||
    !validCount(preview.expiresAt) ||
    !Array.isArray(preview.items) ||
    !Array.isArray(preview.blockers) ||
    !Array.isArray(preview.warnings) ||
    typeof preview.noOp !== "boolean" ||
    !preview.counts ||
    preview.items.length > 5000
  )
    receiptInvalid();
  const tallies = Object.fromEntries(
    Object.values(countKinds).map((key) => [key, 0]),
  );
  for (const item of preview.items) {
    if (
      !item ||
      typeof item.kind !== "string" ||
      !Object.hasOwn(actionLabels, item.action)
    )
      receiptInvalid();
    const tally = Object.hasOwn(countKinds, item.action)
      ? countKinds[item.action]
      : null;
    if (tally) tallies[tally]++;
  }
  if (Object.keys(tallies).some((key) => tallies[key] !== preview.counts[key]))
    receiptInvalid();
  if (!preview.blockers.length && !preview.noOp) {
    if (
      typeof preview.token !== "string" ||
      !preview.token ||
      preview.token.length > 4096 ||
      !["createdLineages", "addedSnapshots", "prunedSnapshots"].every((key) =>
        validCount(preview.historyImpact?.[key]),
      )
    )
      receiptInvalid();
  }
  return (
    !preview.blockers.length &&
    !preview.noOp &&
    tallies.created > 0 &&
    preview.historyImpact.prunedSnapshots === 0 &&
    preview.items.every(
      ({ key, kind, action, reason }) =>
        Object.hasOwn(kindLabels, kind) &&
        (excluded?.has(key)
          ? action === "skip" && reason === "not_selected"
          : action === "create" || action === "reuse"),
    )
  );
}

export function assertOpenAPIApplyReceipt(applied, preview) {
  if (
    !applied ||
    applied.noOp !== false ||
    applied.configRevision !== preview.configRevision + 1 ||
    !validCount(applied.revision) ||
    applied.revision < applied.configRevision ||
    Object.values(countKinds).some(
      (key) => applied.counts?.[key] !== preview.counts[key],
    )
  )
    throw Error("导入回执缺失或版本不匹配");
}

// Only a single direct JSON operation can be unambiguously labeled with
// source metadata; otherwise present the authoritative planned row counts.
function singleOperationHint(document) {
  let source;
  try {
    source = JSON.parse(document.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!source?.openapi && !source?.swagger) return null;
  const methods = ["get", "post", "put", "patch", "delete", "head", "options"];
  let found;
  for (const [path, item] of Object.entries(source.paths || {})) {
    if (!path.startsWith("/") || !item || typeof item !== "object" || item.$ref)
      return null;
    for (const [method, descriptor] of Object.entries(item)) {
      if (!methods.includes(method)) continue;
      if (found || !descriptor || typeof descriptor !== "object") return null;
      found = {
        method: method.toUpperCase(),
        label:
          typeof descriptor.summary === "string" && descriptor.summary
            ? descriptor.summary
            : path,
      };
    }
  }
  return found
    ? `<strong class="openapi-file-method">${found.method}</strong><span>${esc(found.label.slice(0, 180))}</span>`
    : null;
}

export function openAPIReviewMarkup({
  projectName,
  fileName,
  preview,
  input,
  canApply,
  scope,
}) {
  const groups = Object.groupBy(preview.items, (row) => row.kind);
  const advertised = ["api", "model", "environment", "folder"];
  const count = (kind) => groups[kind]?.length || 0;
  const hint = count("api") === 1 ? singleOperationHint(input.document) : null;
  const order = Object.entries(kindLabels).map(([kind]) => kind);
  const grouped = [
    ...order.flatMap((kind) => groups[kind] || []),
    ...preview.items.filter((item) => !Object.hasOwn(kindLabels, item.kind)),
  ];
  const counters = new Map();
  const rows = grouped.map((row) => {
    const index = (counters.get(row.kind) || 0) + 1;
    counters.set(row.kind, index);
    const label = Object.hasOwn(kindLabels, row.kind)
      ? kindLabels[row.kind]
      : "其他资源";
    const operation = scope?.labels.get(row.key);
    const content = operation
      ? `<label class="openapi-file-choice"><input type="checkbox" value="${esc(row.key)}" data-openapi-review-check checked><strong class="openapi-file-method">${operation.method}</strong><span>${esc(operation.label)}</span></label>`
      : row.kind === "api" && hint
        ? hint
        : `<span>${label} ${index}</span>`;
    return `<li>${content}<span class="openapi-file-action"${scope ? ` data-openapi-review-action="${esc(row.key)}"` : ""}>${scope && !canApply ? "待更新" : actionLabels[row.action]}</span></li>`;
  });
  const notice = preview.blockers.length
    ? "发现冲突，未导入任何内容。"
    : preview.noOp
      ? "没有需要导入的变化。"
      : scope
        ? "只导入所选接口及必要依赖，改变选择后需先更新预览。"
        : canApply
          ? "本次确认将导入全部计划项，不支持逐项选择。"
          : "该计划包含本安全导入入口不支持的变更，未导入任何内容。";
  return `<section class="openapi-file-review" tabindex="-1" aria-label="文件导入计划">
    <div class="openapi-file-summary" aria-label="资源数量">${advertised.map((kind) => `<span${scope && kind === "api" ? ' id="openapi-review-count" role="status"' : ""}>${kindLabels[kind]}（${scope && kind === "api" ? count(kind) + "/" : ""}${count(kind)}）</span>`).join("")}</div>
    <p class="openapi-file-destination">${esc(fileName)} · 导入到「${esc(projectName)}」</p>
    ${scope ? `<div class="openapi-file-selection-tools"><label><input type="checkbox" id="openapi-review-all" checked>全选接口</label><button type="button" id="openapi-review-refresh">更新预览</button></div><p id="openapi-review-selection-status" role="status">${canApply ? "" : "请更新预览以核对实际导入的依赖。"}</p>` : ""}
    ${rows.length ? `<ul class="openapi-file-items" aria-label="计划导入资源">${rows.join("")}</ul>` : ""}
    <p class="openapi-file-note">${notice} 此预览不保存项目或发送请求。${preview.warnings.length ? ` 有 ${preview.warnings.length} 条警告。` : ""}${preview.blockers.length ? ` 有 ${preview.blockers.length} 处阻止导入的冲突。` : ""}</p>
    <p id="openapi-file-review-error" role="alert"></p>
  </section>`;
}
