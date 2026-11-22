const tabs = [
  ["headers", "Header"],
  ["query", "Query"],
  ["path", "Path"],
  ["body", "Body"],
  ["auth", "认证"],
  ["cookies", "Cookie"],
  ["before", "预执行操作"],
  ["after", "后执行操作"],
  ["examples", "响应示例"],
  ["assertions", "断言"],
  ["extract", "提取变量"],
];

export const namedFormRows = (request) =>
  (request.form || []).filter((row) => String(row.key || "").trim()).length;

export function requestParameterTabs(request, active) {
  return `<div class="param-tabs" role="group" aria-label="请求参数">${tabs
    .map(([key, label]) => {
      const selected = active === key;
      const count =
        key === "body"
          ? ["form-data", "urlencoded"].includes(request.bodyType)
            ? namedFormRows(request)
            : Number(request.bodyType !== "none")
          : Array.isArray(request[key])
            ? request[key].length
            : 0;
      return `<button type="button" data-param="${key}" class="${selected ? "active" : ""}" aria-pressed="${selected}">${label}${count ? " (" + count + ")" : ""}</button>`;
    })
    .join("")}</div>`;
}

export function revealParameterTab(strip, button) {
  const edges = strip.getBoundingClientRect();
  const target = button.getBoundingClientRect();
  if (target.left < edges.left) strip.scrollLeft += target.left - edges.left;
  else if (target.right > edges.right)
    strip.scrollLeft += target.right - edges.right;
}
