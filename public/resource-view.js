const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const resources = {
  functions: {
    name: "自定义函数",
    sample: [{ name: "double", body: "return args[0] * 2;" }],
    help: "通过 utils.函数名(...) 调用。函数体使用 args 数组，运行于同一隔离沙箱；计划保存函数快照。",
  },
  statusCodes: {
    name: "状态码字典",
    sample: [
      { code: 200, label: "成功" },
      { code: 401, label: "未授权" },
    ],
    help: "为100至599状态码维护项目内解释。",
  },
  attributes: {
    name: "接口属性",
    sample: [{ key: "owner", label: "负责人", type: "string" }],
    help: "支持 string / number / boolean，在接口设计页填写。",
  },
  statuses: {
    name: "接口状态",
    sample: [
      { id: "developing", name: "开发中", color: "#2874b5" },
      { id: "ready", name: "已完成", color: "#23836b" },
    ],
    help: "在接口工具栏选择项目维护的生命周期状态。",
  },
};
export function resourcePanels(project) {
  return Object.entries(resources)
    .map(
      ([key, spec]) =>
        '<section class="card" id="resource-' +
        key +
        '"><div class="row"><h3 class="grow">' +
        spec.name +
        '</h3><button data-edit-resource="' +
        key +
        '">编辑' +
        spec.name +
        '</button></div><p class="muted">' +
        spec.help +
        "</p><pre>" +
        esc(JSON.stringify(project.settings?.[key] || [], null, 2)) +
        "</pre></section>",
    )
    .join("");
}
export function settingsSidebar() {
  return (
    '<div class="settings-nav"><strong>项目配置</strong>' +
    [
      ["settings-basic", "基本设置"],
      ["settings-environments", "环境与服务"],
      ["settings-mock", "Mock 服务"],
      ["resource-functions", "自定义函数"],
      ["resource-statusCodes", "状态码字典"],
      ["resource-attributes", "接口属性"],
      ["resource-statuses", "接口状态"],
      ["settings-mcp", "MCP 连接"],
    ]
      .map(
        ([id, title]) =>
          '<button data-settings-anchor="' + id + '">' + title + "</button>",
      )
      .join("") +
    '<hr><strong>导入 / 导出</strong><button id="import">导入项目（手动）</button><button id="export">导出项目</button></div>'
  );
}
