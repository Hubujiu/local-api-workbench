const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function stepEditor(step) {
  const r = step.request;
  const input = (key, label, value) =>
    "<label>" +
    label +
    '</label><input data-step-field="' +
    key +
    '" value="' +
    esc(value) +
    '">';
  const textarea = (key, label, value) =>
    "<label>" +
    label +
    '</label><textarea data-step-field="' +
    key +
    '" spellcheck="false">' +
    esc(value) +
    "</textarea>";
  return (
    '<div class="step-editor"><p class="notice">仅编辑此步骤快照；不修改源接口。变量使用 {{name}}。</p>' +
    input("name", "步骤名称", step.name) +
    '<label>请求方法</label><select data-step-field="method">' +
    ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
      .map(
        (m) =>
          "<option " +
          (r.method === m ? "selected" : "") +
          ">" +
          m +
          "</option>",
      )
      .join("") +
    "</select>" +
    input("url", "请求 URL", r.url) +
    ["headers", "query", "path", "cookies"]
      .map(
        (key) =>
          "<details><summary>" +
          {
            headers: "Header",
            query: "Query",
            path: "Path",
            cookies: "Cookie",
          }[key] +
          '</summary><div data-step-pairs="' +
          key +
          '">' +
          (r[key] || [])
            .map((row, index) => pairRow(key, index, row))
            .join("") +
          '</div><button data-step-add="' +
          key +
          '">添加参数</button></details>',
      )
      .join("") +
    '<details open><summary>请求体</summary><label>Body 类型</label><select data-step-field="bodyType">' +
    ["none", "json", "raw", "form-data", "urlencoded", "binary", "msgpack"]
      .map(
        (t) =>
          "<option " +
          (r.bodyType === t ? "selected" : "") +
          ">" +
          t +
          "</option>",
      )
      .join("") +
    "</select>" +
    textarea("body", "JSON / 文本 / Base64 内容", r.body) +
    '<p class="muted">表单文件、认证、TLS、断言与提取规则保留；复杂配置可用计划 JSON 编辑。</p></details>' +
    "<details><summary>本步骤脚本</summary>" +
    textarea("beforeScript", "前置脚本（隔离 VM）", r.beforeScript) +
    textarea("afterScript", "后置脚本（隔离 VM）", r.afterScript) +
    "</details></div>"
  );
}
export function pairRow(key, index, row = {}) {
  return (
    '<div class="row" data-step-pair-row="' +
    key +
    ":" +
    index +
    '"><input type="checkbox" data-step-enabled ' +
    (row.enabled !== false ? "checked" : "") +
    ' aria-label="启用参数"><input data-step-key value="' +
    esc(row.key) +
    '" placeholder="参数名" aria-label="参数名"><input data-step-value value="' +
    esc(row.value) +
    '" placeholder="参数值" aria-label="参数值"><button data-step-remove aria-label="移除参数">×</button></div>'
  );
}
export function applyStepEdits(step, fields, pairGroups) {
  const next = structuredClone(step);
  next.name = String(fields.name || "").trim();
  if (!next.name) throw Error("步骤名称不能为空");
  for (const key of [
    "method",
    "url",
    "bodyType",
    "body",
    "beforeScript",
    "afterScript",
  ])
    if (Object.hasOwn(fields, key)) next.request[key] = fields[key];
  for (const key of ["headers", "query", "path", "cookies"]) {
    if (!pairGroups[key]) continue;
    next.request[key] = pairGroups[key].map((row) => ({
      ...(Number.isInteger(row.index)
        ? structuredClone(step.request[key]?.[row.index] || {})
        : {}),
      key: String(row.key),
      value: String(row.value),
      enabled: Boolean(row.enabled),
    }));
  }
  return next;
}
