const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function errorCodeHTML(codes = []) {
  if (!codes.length) return "";
  return (
    '<section class="card error-code-document"><h2>状态码 / 错误码</h2><table><thead><tr><th>代码</th><th>说明</th></tr></thead><tbody>' +
    codes
      .map(
        (item) =>
          "<tr><td><code>" +
          esc(item.code) +
          "</code></td><td>" +
          esc(item.label).replace(/\n/g, "<br>") +
          "</td></tr>",
      )
      .join("") +
    "</tbody></table></section>"
  );
}
export function errorCodeMarkdown(codes = []) {
  if (!codes.length) return "";
  const cell = (value) =>
    esc(value)
      .replace(/([\\`*_{}\[\]()#+.!|])/g, "\\$1")
      .replace(/\r?\n/g, " / ");
  return (
    "\n\n## 状态码 / 错误码\n\n| 代码 | 说明 |\n| --- | --- |\n" +
    codes
      .map((item) => "| " + cell(item.code) + " | " + cell(item.label) + " |")
      .join("\n") +
    "\n"
  );
}
export function errorCodePanel(project) {
  return (
    '<section class="card"><p>统一维护业务错误码及说明，当前接口文档会使用最新字典。已导出的静态文件需重新导出。</p><div class="toolbar"><button id="new-error-code" class="primary">新增错误码</button><button id="bulk-error-codes">批量编辑</button><button data-edit-resource="statusCodes">JSON 高级编辑</button></div><table><thead><tr><th>代码</th><th>说明</th><th>HTTP提示</th><th></th></tr></thead><tbody>' +
    (project.settings?.statusCodes || [])
      .map(
        (item, index) =>
          "<tr><td>" +
          esc(item.code) +
          "</td><td>" +
          esc(item.label) +
          "</td><td>" +
          (item.httpHint ? "是" : "否") +
          '</td><td><button data-edit-error-code="' +
          index +
          '">编辑</button><button data-delete-error-code="' +
          index +
          '">删除</button></td></tr>',
      )
      .join("") +
    "</tbody></table></section>"
  );
}
