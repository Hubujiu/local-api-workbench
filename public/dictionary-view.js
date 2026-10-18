const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function dictionaryPanel(project, temporary = []) {
  return (
    '<section><label><input id="builtin-dictionary" type="checkbox" ' +
    (project.settings?.builtinDictionary ? "checked" : "") +
    '>启用内置常用参数</label><div class="page-head"><div><h1>参数数据字典</h1><p class="muted">维护参数名、类型、说明、默认值、示例与枚举。选择参数时可复用。</p></div><div class="row"><button id="import-parameter-dictionary">导入字典</button><button id="new-parameter-entry" class="primary">新增参数</button></div></div><table><thead><tr><th>参数名 / 备注</th><th>类型</th><th>说明</th><th>默认值 / 示例</th><th></th></tr></thead><tbody>' +
    (project.parameterDictionary || [])
      .map(
        (entry) =>
          "<tr><td><strong>" +
          esc(entry.key) +
          "</strong><br>" +
          esc(entry.note) +
          "</td><td>" +
          esc(entry.type) +
          "</td><td>" +
          esc(entry.description) +
          "</td><td>" +
          esc(JSON.stringify(entry.default ?? entry.example ?? "")) +
          '</td><td><button data-edit-parameter-entry="' +
          esc(entry.id) +
          '">编辑</button><button data-delete-parameter-entry="' +
          esc(entry.id) +
          '">删除</button></td></tr>',
      )
      .join("") +
    "</tbody></table>" +
    (!project.parameterDictionary?.length
      ? '<div class="notice">尚无字典参数。可通过 key-value、JSON 或 MySQL DDL 导入。</div>'
      : "") +
    (temporary.length
      ? "<h3>临时捕获 · 刷新后消失</h3>" +
        temporary
          .map(
            (entry, index) =>
              '<div class="row"><span class="grow">' +
              esc(entry.key) +
              " · " +
              esc(entry.description) +
              '</span><button data-save-temporary-parameter="' +
              index +
              '">保存至字典</button></div>',
          )
          .join("")
      : "") +
    "</section>"
  );
}

export const builtinParameters = [
  {
    id: "builtin-id",
    key: "id",
    type: "integer",
    description: "唯一标识",
    example: 1,
    note: "内置",
  },
  {
    id: "builtin-name",
    key: "name",
    type: "string",
    description: "名称",
    example: "示例",
    note: "内置",
  },
  {
    id: "builtin-email",
    key: "email",
    type: "string",
    description: "电子邮箱",
    example: "user@example.com",
    note: "内置",
  },
  {
    id: "builtin-page",
    key: "page",
    type: "integer",
    description: "页码",
    default: 1,
    note: "内置",
  },
  {
    id: "builtin-pageSize",
    key: "pageSize",
    type: "integer",
    description: "每页条数",
    default: 20,
    note: "内置",
  },
];
export function effectiveParameterDictionary(project) {
  const custom = project.parameterDictionary || [];
  return [
    ...custom,
    ...(project.settings?.builtinDictionary
      ? builtinParameters.filter(
          (entry) =>
            !custom.some(
              (item) => item.key === entry.key && item.type === entry.type,
            ),
        )
      : []),
  ];
}
