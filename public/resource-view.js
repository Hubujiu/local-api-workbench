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
      { code: 0, label: "业务成功" },
      { code: "AUTH_EXPIRED", label: "登录过期" },
    ],
    help: "维护业务错误码与描述；字符串、0、负数和普通整数均可。httpHint:true 可选用于100至599的HTTP状态提示。",
  },
  attributes: {
    name: "接口属性",
    sample: [{ key: "owner", label: "负责人", type: "string" }],
    help: "支持 string / number / select / multiselect / date / url / email，兼容 boolean；选择类型使用 options 数组。属性默认不导出，分享时选择。",
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
export function resourcePanels(project, only) {
  return Object.entries(resources)
    .filter(([key]) => !only || key === only)
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
export function settingsSidebar(active = "settings-basic") {
  return (
    '<div class="settings-nav"><strong>项目配置</strong>' +
    [
      ["settings-basic", "基本设置"],
      ["settings-environments", "环境与服务"],
      ["settings-mock", "Mock 服务"],
      ["settings-mock-fields", "智能 Mock 匹配"],
      ["resource-functions", "自定义函数"],
      ["resource-statusCodes", "状态码字典"],
      ["resource-attributes", "接口属性"],
      ["resource-statuses", "接口状态"],
      ["settings-mcp", "MCP 连接"],
    ]
      .map(
        ([id, title]) =>
          '<button data-settings-anchor="' +
          id +
          '" class="' +
          (active === id ? "active" : "") +
          '" ' +
          (active === id ? 'aria-current="page"' : "") +
          ">" +
          title +
          "</button>",
      )
      .join("") +
    '<hr><strong>连接</strong><button data-page="database">数据库连接</button><hr><strong>导入 / 导出</strong><button id="import">导入项目（手动）</button><button id="export">导出项目</button></div>'
  );
}
