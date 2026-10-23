import { renderMarkdown } from "./vendor/markdown-renderer.js";
import { attributeHTML, attributeMarkdown } from "./attribute-view.js";
import { errorCodeHTML, errorCodeMarkdown } from "./error-code-view.js";
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const markdownText = (value) =>
  escape(value)
    .replace(/([\\`*_{}\[\]()#+.!|>~-])/g, "\\$1")
    .replace(/\r\n|\r|\n/g, "<br>");
const groups = [
  ["query", "Query 参数"],
  ["path", "Path 参数"],
  ["headers", "Header 参数"],
];
const columns = ["参数", "示例", "类型 / 必填 / Schema", "状态", "说明"];
function codeBlock(value, language = "") {
  const text = String(value ?? "");
  const length = (expression) => {
    let size = 3;
    for (const match of text.matchAll(expression))
      size = Math.max(size, match[0].length + 1);
    return size;
  };
  const ticks = length(/`+/g),
    tildes = length(/~+/g);
  const fence = ticks <= tildes ? "`".repeat(ticks) : "~".repeat(tildes);
  return (
    fence +
    language +
    "\n" +
    text +
    (!text || text.endsWith("\n") ? "" : "\n") +
    fence +
    "\n"
  );
}
function hasSchema(schema) {
  return (
    typeof schema === "boolean" ||
    (schema && typeof schema === "object" && Object.keys(schema).length > 0)
  );
}
function parameterRows(parameters, form = false) {
  return parameters.map((parameter) => {
    const file = form && parameter.type === "file";
    const type = file
      ? "file"
      : parameter.schema === false
        ? "禁止值"
        : parameter.schema === true
          ? "任意"
          : parameter.schema?.type || "string";
    const constraints = hasSchema(parameter.schema)
      ? "\n" + JSON.stringify(parameter.schema)
      : "";
    return [
      parameter.key,
      file
        ? "文件：" +
          (parameter.filename || "未指定") +
          (parameter.requiresFile ? "（待重新选择）" : "（内容不内嵌）")
        : (parameter.value ?? ""),
      String(type) +
        (parameter.required === true ? " · 必填" : "") +
        constraints,
      parameter.enabled === false ? "停用" : "启用",
      parameter.description || "",
    ];
  });
}
function tableHTML(rows) {
  if (!rows.length) return '<p class="muted">无表单项</p>';
  return (
    '<div class="doc-table-scroll" role="region" aria-label="参数表，可横向滚动" tabindex="0"><table class="doc-parameter-table"><colgroup><col style="width:16%"><col style="width:34%"><col style="width:24%"><col style="width:8%"><col style="width:18%"></colgroup><thead><tr>' +
    columns.map((c) => "<th>" + escape(c) + "</th>").join("") +
    "</tr></thead><tbody>" +
    rows
      .map(
        (row) =>
          "<tr>" +
          row
            .map(
              (value) => '<td class="doc-literal">' + escape(value) + "</td>",
            )
            .join("") +
          "</tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}
function tableMarkdown(rows) {
  if (!rows.length) return "无表单项\n";
  return (
    "| " +
    columns.join(" | ") +
    " |\n| " +
    columns.map(() => "---").join(" | ") +
    " |\n" +
    rows
      .map((row) => "| " + row.map(markdownText).join(" | ") + " |")
      .join("\n") +
    "\n"
  );
}
function documentationResponses(request) {
  const definitions = request.responses ?? [];
  if (
    request.openapiExampleBindingsVersion !== 1 ||
    !Array.isArray(definitions)
  )
    return definitions;
  const result = structuredClone(definitions);
  for (const definition of result) {
    for (const media of Object.values(definition?.content || {})) {
      if (!media || typeof media !== "object" || Array.isArray(media)) continue;
      delete media.example;
      if (
        media.examples &&
        typeof media.examples === "object" &&
        !Array.isArray(media.examples)
      ) {
        media.examples = Object.fromEntries(
          Object.entries(media.examples).filter(
            ([, entry]) =>
              !entry ||
              typeof entry !== "object" ||
              !Object.hasOwn(entry, "value"),
          ),
        );
        if (!Object.keys(media.examples).length) delete media.examples;
      }
    }
  }
  return result;
}
function exampleDescription(request, example) {
  if (typeof example.description === "string") return example.description;
  const source = example.openapiExampleSource;
  if (
    request.openapiExampleBindingsVersion !== 1 ||
    source?.kind !== "examples"
  )
    return "";
  const definition = (request.responses || []).find(
    (item) => String(item.status) === String(source.status),
  );
  const entries = definition?.content?.[source.mediaType]?.examples;
  const entry =
    entries && Object.hasOwn(entries, source.key)
      ? entries[source.key]
      : undefined;
  return typeof entry?.description === "string" ? entry.description : "";
}
export function requestDocumentationHTML(request, headingLevel = 3) {
  if (!Number.isInteger(headingLevel) || headingLevel < 1 || headingLevel > 6)
    throw Error("文档标题层级无效");
  const heading = (text) =>
    `<h${headingLevel}>${escape(text)}</h${headingLevel}>`;
  let result = groups
    .map(([kind, label]) =>
      request[kind]?.length
        ? heading(label) + tableHTML(parameterRows(request[kind]))
        : "",
    )
    .join("");
  if (request.scriptURLMode === "sdk")
    result =
      "<p>SDK URL对象模式：脚本可修改URL集合；此处展示请求定义，不是执行后的请求。cURL仅支持无前置脚本或操作的请求定义；OpenAPI仅支持无前置处理、无Path变量/运行时状态的静态URL定义，且Query名称须唯一；其余请使用项目备份。</p>" +
      result;
  if (request.queryAddEqual === false)
    result =
      "<p>空值 Query 参数不添加等号；URL 中已有查询保持原样。</p>" + result;
  if (["apipost", "apipost-name"].includes(request.cookieEncoding))
    result =
      "<p>Cookie参数编码：" +
      (request.cookieEncoding === "apipost" ? "名称和值" : "仅名称") +
      "避免重复编码；不改写显式Cookie请求头或Cookie管理器内容。</p>" +
      result;
  const type = request.bodyType ?? "none";
  if (type !== "none")
    result +=
      heading("请求体 · " + type) +
      (["form-data", "urlencoded"].includes(type)
        ? tableHTML(parameterRows(request.form || [], true))
        : "<pre>" + escape(request.body) + "</pre>");
  if (hasSchema(request.schema))
    result +=
      heading("请求结构") +
      "<pre>" +
      escape(JSON.stringify(request.schema, null, 2)) +
      "</pre>";
  const definitions = documentationResponses(request);
  result +=
    heading("响应定义") +
    ((Array.isArray(definitions) ? definitions.length : definitions)
      ? "<pre>" + escape(JSON.stringify(definitions, null, 2)) + "</pre>"
      : '<p class="muted">未配置响应结构</p>');
  for (const example of request.examples || []) {
    result += heading((example.name ?? "") + " · " + (example.status ?? ""));
    const description = exampleDescription(request, example);
    if (description)
      result += '<p class="doc-literal">' + escape(description) + "</p>";
    if (example.headers && Object.keys(example.headers).length)
      result +=
        "<p>示例响应 Header</p><pre>" +
        escape(JSON.stringify(example.headers, null, 2)) +
        "</pre>";
    if (example.delayMs !== undefined)
      result +=
        "<p>Mock 延迟：" +
        escape(example.delayMs) +
        " ms（非服务时延保证）</p>";
    result += "<pre>" + escape(example.body) + "</pre>";
  }
  return result;
}
function requestDocumentationMarkdown(request) {
  let result = groups
    .map(([kind, label]) =>
      request[kind]?.length
        ? "### " +
          label +
          "\n\n" +
          tableMarkdown(parameterRows(request[kind])) +
          "\n"
        : "",
    )
    .join("");
  if (request.scriptURLMode === "sdk")
    result =
      "SDK URL对象模式：脚本可修改URL集合；此处展示请求定义，不是执行后的请求。cURL仅支持无前置脚本或操作的请求定义；OpenAPI仅支持无前置处理、无Path变量/运行时状态的静态URL定义，且Query名称须唯一；其余请使用项目备份。\n\n" +
      result;
  if (request.queryAddEqual === false)
    result = "空值 Query 参数不添加等号；URL 中已有查询保持原样。\n\n" + result;
  if (["apipost", "apipost-name"].includes(request.cookieEncoding))
    result =
      "Cookie参数编码：" +
      (request.cookieEncoding === "apipost" ? "名称和值" : "仅名称") +
      "避免重复编码；不改写显式Cookie请求头或Cookie管理器内容。\n\n" +
      result;
  const type = request.bodyType ?? "none";
  if (type !== "none")
    result +=
      "### 请求体 · " +
      markdownText(type) +
      "\n\n" +
      (["form-data", "urlencoded"].includes(type)
        ? tableMarkdown(parameterRows(request.form || [], true))
        : codeBlock(request.body, type === "json" ? "json" : "")) +
      "\n";
  if (hasSchema(request.schema))
    result +=
      "### 请求结构\n\n" +
      codeBlock(JSON.stringify(request.schema, null, 2), "json") +
      "\n";
  const definitions = documentationResponses(request);
  result +=
    "### 响应定义\n\n" +
    ((Array.isArray(definitions) ? definitions.length : definitions)
      ? codeBlock(JSON.stringify(definitions, null, 2), "json") + "\n"
      : "未配置响应结构\n\n");
  for (const example of request.examples || []) {
    result +=
      "### " +
      markdownText(example.name) +
      " · " +
      markdownText(example.status) +
      "\n\n";
    const description = exampleDescription(request, example);
    if (description) result += markdownText(description) + "\n\n";
    if (example.headers && Object.keys(example.headers).length)
      result +=
        "示例响应 Header\n\n" +
        codeBlock(JSON.stringify(example.headers, null, 2), "json") +
        "\n";
    if (example.delayMs !== undefined)
      result +=
        "Mock 延迟：" +
        markdownText(example.delayMs) +
        " ms（非服务时延保证）\n\n";
    result += codeBlock(example.body) + "\n";
  }
  return result;
}
export function exportDocumentation(
  project,
  format = "markdown",
  options = {},
) {
  const requests = project.requests.filter((request) => !request.deletedAt);
  if (format === "markdown")
    return (
      "# " +
      markdownText(project.name) +
      errorCodeMarkdown(project.settings?.statusCodes || []) +
      "\n\n" +
      (project.documents || [])
        .map(
          (document) =>
            "## " +
            markdownText(document.title) +
            attributeMarkdown(project, document, options.attributeKeys) +
            "\n\n" +
            document.content,
        )
        .join("\n\n") +
      "\n\n" +
      requests
        .map(
          (request) =>
            "## " +
            markdownText(request.name) +
            attributeMarkdown(project, request, options.attributeKeys) +
            "\n\n" +
            markdownText(request.method) +
            " " +
            markdownText(request.url) +
            "\n\n" +
            (request.description || "") +
            "\n\n" +
            requestDocumentationMarkdown(request),
        )
        .join("\n\n")
    );
  const content =
    errorCodeHTML(project.settings?.statusCodes || []) +
    (project.documents || [])
      .map(
        (document) =>
          `<section><h2>${escape(document.title)}</h2>${attributeHTML(project, document, options.attributeKeys)}<div class="markdown-content">${renderMarkdown(document.content)}</div></section>`,
      )
      .join("") +
    requests
      .map(
        (request, index) =>
          `<section id="request-${index}"><span class="method">${escape(request.method)}</span><h2>${escape(request.name)}</h2>${attributeHTML(project, request, options.attributeKeys)}<code>${escape(request.url)}</code><div class="markdown-content">${renderMarkdown(request.description)}</div>${requestDocumentationHTML(request)}</section>`,
      )
      .join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escape(project.name)} · API 文档</title><style>body{font:14px/1.7 system-ui,sans-serif;color:#353129;background:#faf7ef;margin:0}header,main{max-width:1000px;margin:auto;padding:30px}nav{display:flex;flex-wrap:wrap;gap:12px}a{color:#8a6d37}section{background:white;border:1px solid #e8e2d5;border-radius:8px;padding:24px;margin:18px 0}h2{margin-top:0}.method{float:right;color:#35a58a;font-weight:bold}pre,code{white-space:pre-wrap;overflow-wrap:anywhere;background:#f8f6f0;padding:12px;border-radius:4px;display:block}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{padding:8px;border-bottom:1px solid #eee;text-align:left;overflow-wrap:anywhere}.doc-literal{white-space:pre-wrap}.doc-table-scroll{max-width:100%;min-width:0;overflow-x:auto}.doc-table-scroll:focus-visible{outline:2px solid #8a6d37;outline-offset:2px}.doc-parameter-table{min-width:720px;table-layout:fixed}.doc-parameter-table th,.doc-parameter-table td:nth-child(4){white-space:nowrap}</style><header><h1>${escape(project.name)}</h1><p>离线 API 文档 · Local API Workbench</p><nav>${requests.map((request, index) => `<a href="#request-${index}">${escape(request.name)}</a>`).join("")}</nav></header><main>${content}</main></html>`;
}
