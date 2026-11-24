import { icon } from "./icons.js";

const steps = [
  ["打开 MCP 设置", "按需启动本机服务。只使用 HTTP 调试时，可跳过这一步。"],
  ["选择项目与权限", "只授权需要访问的项目；写入与执行需要分别允许。"],
  ["连接受信任的客户端", "选择适用的配置，把连接密钥保留在本机。"],
  ["先验证一项小任务", "例如读取接口定义。执行前先核对接口地址、数据和权限。"],
];

export function apiWelcome() {
  return `<section class="api-welcome" aria-labelledby="api-welcome-title">
    <div class="api-welcome-content">
      <p class="api-welcome-brand"><span aria-hidden="true">${icon("↗")}</span>Local API 单机版</p>
      <h1 id="api-welcome-title">在本机管理和调试 API</h1>
      <p class="api-welcome-intro">创建或导入接口，也可通过 MCP 让受信任的客户端访问已授权项目。</p>
      <section class="api-welcome-card" aria-labelledby="api-welcome-steps">
        <h2 id="api-welcome-steps">四步连接本机 MCP</h2>
        <p>以下配置均由你确认。打开设置不会启用服务或授予权限。</p>
        <ol role="list">${steps
          .map(
            ([heading, guidance], index) => `
          <li><span class="api-welcome-number" aria-hidden="true">${index + 1}</span><div><h3>${heading}</h3><p>${guidance}</p></div></li>
        `,
          )
          .join("")}</ol>
        <button id="welcome-mcp" type="button" class="primary" data-page="settings" data-settings-target="settings-mcp">打开 MCP 设置 <span aria-hidden="true">→</span></button>
      </section>
      <div class="api-welcome-actions">
        <button id="welcome-import" type="button" aria-haspopup="dialog"><span aria-hidden="true">${icon("folder")}</span>导入项目</button>
        <button id="welcome-add" type="button"><span aria-hidden="true">${icon("copy-request")}</span>新建 HTTP 接口</button>
      </div>
    </div>
  </section>`;
}
