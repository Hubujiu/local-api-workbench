import { attributePanel } from "./attribute-view.js";
import { errorCodePanel } from "./error-code-view.js";
import { mockFieldPanel } from "./mock-field-view.js";
import { environmentExtras } from "./environment-view.js";
import { resourcePanels, resources } from "./resource-view.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function settingsPanel(project, active = "settings-basic") {
  let title = "基本设置",
    content = "";
  if (active === "settings-environments") {
    title = "环境与服务";
    content =
      '<div class="page-head"><h2>环境管理</h2><button id="clear-session">清空调试临时变量</button><button id="add-env">＋ 新建环境</button></div>' +
      project.environments
        .map(
          (e) =>
            '<div class="card"><div class="row"><strong class="grow">' +
            esc(e.name) +
            '</strong><button data-debug-env="' +
            esc(e.id) +
            '">运行时变量</button><button data-edit-env="' +
            esc(e.id) +
            '">编辑变量</button><button data-delete-env="' +
            esc(e.id) +
            '" class="danger">删除</button></div><pre>' +
            esc(JSON.stringify(e.variables, null, 2)) +
            "</pre></div>",
        )
        .join("") +
      environmentExtras(project);
  } else if (active === "resource-attributes") {
    title = "接口属性";
    content = attributePanel(project);
  } else if (active === "resource-statusCodes") {
    title = "状态码字典";
    content = errorCodePanel(project);
  } else if (active.startsWith("resource-") && resources[active.slice(9)]) {
    const key = active.slice(9);
    title = resources[key].name;
    content = resourcePanels(project, key);
  } else if (active === "settings-mock") {
    title = "Mock 服务";
    content =
      '<section id="settings-mock" class="card"><label><input id="mock-enabled" type="checkbox" ' +
      (project.settings?.mockEnabled !== false ? "checked" : "") +
      '>启用本项目本地 Mock</label><p class="muted">在接口的 Mock 页维护响应示例与条件响应期望。规则从上到下匹配，一条规则内所有条件必须满足。</p></section>';
  } else if (active === "settings-mock-fields") {
    title = "智能 Mock 匹配";
    content = mockFieldPanel(project);
  } else if (active === "settings-mcp") {
    title = "MCP 连接";
    content =
      '<div class="card" id="settings-mcp"><h3>本地 MCP 服务</h3><button id="mcp-config" class="primary">配置本地 HTTP MCP 服务</button><p class="muted">默认关闭。项目与读写/执行权限需分别授权；仅在勾选保留授权后跨重启生效。</p><p>使用 stdio 模式启动，默认只读；必须显式授权项目。</p><pre>node src/mcp.mjs --project ' +
      esc(project.id) +
      '</pre><p class="muted">需要写入时加入 --write，需要执行请求时额外加入 --execute。不会自动更改你的 Agent 配置。</p></div>';
  } else {
    content =
      '<div class="card"><div class="form-grid"><label>项目名称</label><input id="project-name" value="' +
      esc(project.name) +
      '"></div></div><div class="notice">数据保存在项目所选的本地位置（桌面默认应用数据目录）。变量可能包含密钥；导出或 Git 提交前请移除秘密。默认不上传任何内容。</div>';
  }
  return (
    '<div class="page settings-content"><div class="page-head"><div><h1>' +
    title +
    '</h1><span class="muted">项目配置 · ' +
    esc(project.name) +
    '</span></div><div class="toolbar"><button id="archive-project" class="danger">归档项目</button><button id="save" class="primary">保存配置</button></div></div>' +
    content +
    "</div>"
  );
}
