import { designPathTabLabel } from "./design-path-draft.js";

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

const graphqlTabs = [
  ["graphql", "Query"],
  ["headers", "Header"],
  ["auth", "认证"],
  ["cookies", "Cookie"],
  ["before", "预执行操作"],
  ["after", "后执行操作"],
  ["query", "URL 参数"],
  ...tabs.filter(([key]) =>
    ["path", "examples", "assertions", "extract"].includes(key),
  ),
];
export const namedFormRows = (request) =>
  (request.form || []).filter((row) => String(row.key || "").trim()).length;

export function requestParameterTabs(request, active, pathLinked = false) {
  return `<div class="param-tabs" role="group" aria-label="请求参数">${(request.graphqlEditorVersion ===
  1
    ? graphqlTabs
    : tabs
  )
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
      const text =
        key === "path" && pathLinked
          ? designPathTabLabel(request, { debug: true })
          : label + (count ? " (" + count + ")" : "");
      return `<button type="button" data-param="${key}" class="${selected ? "active" : ""}" aria-pressed="${selected}">${text}</button>`;
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
