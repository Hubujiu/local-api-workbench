const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
export function exportDocumentation(project, format = "markdown") {
  const requests = project.requests.filter((request) => !request.deletedAt);
  if (format === "markdown")
    return (
      "# " +
      project.name +
      "\n\n" +
      (project.documents || [])
        .map((document) => "## " + document.title + "\n\n" + document.content)
        .join("\n\n") +
      "\n\n" +
      requests
        .map(
          (request) =>
            `## ${request.name}\n\n${request.method} ${request.url}\n\n${request.description}\n\n${request.bodyType !== "none" ? "```\n" + request.body + "\n```\n" : ""}${request.examples.map((example) => "### " + example.name + " · " + example.status + "\n\n```\n" + example.body + "\n```").join("\n")}`,
        )
        .join("\n\n")
    );
  const content =
    (project.documents || [])
      .map(
        (document) =>
          `<section><h2>${escape(document.title)}</h2><pre>${escape(document.content)}</pre></section>`,
      )
      .join("") +
    requests
      .map(
        (request, index) =>
          `<section id="request-${index}"><span class="method">${escape(request.method)}</span><h2>${escape(request.name)}</h2><code>${escape(request.url)}</code><p>${escape(request.description)}</p>${["query", "path", "headers"].map((kind) => (request[kind]?.length ? `<h3>${escape(kind)}</h3><table><tr><th>参数</th><th>示例</th><th>类型/必填</th><th>说明</th></tr>${request[kind].map((parameter) => `<tr><td>${escape(parameter.key)}</td><td>${escape(parameter.value)}</td><td>${escape(parameter.schema?.type || "string")}${parameter.required ? " · 必填" : ""}</td><td>${escape(parameter.description || "")}</td></tr>`).join("")}</table>` : "")).join("")}${request.bodyType !== "none" ? `<h3>请求体</h3><pre>${escape(request.body)}</pre>` : ""}<h3>请求结构</h3><pre>${escape(JSON.stringify(request.schema || {}, null, 2))}</pre><h3>响应定义</h3><pre>${escape(JSON.stringify(request.responses || [], null, 2))}</pre>${request.examples.map((example) => `<h3>${escape(example.name)} · ${example.status}</h3><pre>${escape(example.body)}</pre>`).join("")}</section>`,
      )
      .join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(project.name)} · API 文档</title><style>body{font:14px/1.7 system-ui,sans-serif;color:#353129;background:#faf7ef;margin:0}header,main{max-width:1000px;margin:auto;padding:30px}nav{display:flex;flex-wrap:wrap;gap:12px}a{color:#8a6d37}section{background:white;border:1px solid #e8e2d5;border-radius:8px;padding:24px;margin:18px 0}h2{margin-top:0}.method{float:right;color:#35a58a;font-weight:bold}pre,code{white-space:pre-wrap;overflow-wrap:anywhere;background:#f8f6f0;padding:12px;border-radius:4px;display:block}table{border-collapse:collapse;width:100%}th,td{padding:8px;border-bottom:1px solid #eee;text-align:left}</style><header><h1>${escape(project.name)}</h1><p>离线 API 文档 · Local API Workbench</p><nav>${requests.map((request, index) => `<a href="#request-${index}">${escape(request.name)}</a>`).join("")}</nav></header><main>${content}</main></html>`;
}
