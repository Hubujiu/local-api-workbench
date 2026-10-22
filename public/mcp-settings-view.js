import { clientConfiguration, mcpClients } from "./mcp-client-config.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const hidden =
  "连接密钥默认隐藏。点击“查看本机配置”后才显示；不要分享给不信任的客户端。";
export function mcpStatusMarkup(config, projects) {
  const known = Array.isArray(config.projects);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const activityTime =
    typeof config.lastActivity === "object" && config.lastActivity !== null
      ? config.lastActivity.finishedAt || config.lastActivity.startedAt
      : config.lastActivity;
  const time = activityTime ? new Date(activityTime) : null;
  const recent =
    time && Number.isFinite(time.getTime())
      ? time.toLocaleString()
      : "暂无连接记录";
  return `<section class="mcp-service-card"><div class="row"><span class="mcp-state-dot ${known && config.enabled ? "enabled" : ""}"></span><strong>MCP 服务</strong><span class="muted grow">最近活动：${esc(recent)}</span><span class="mcp-state-label">${known ? (config.enabled ? "运行中" : "已关闭") : "读取中"}</span></div><p class="muted">仅在本机运行。关闭服务会撤销当前令牌，不自动修改外部客户端。</p></section><section class="mcp-grants"><h3>授权范围</h3><dl><div><dt>写入项目</dt><dd>${known ? (config.write ? "已允许" : "未允许") : "未读取"}</dd></div><div><dt>执行已有计划</dt><dd>${known ? (config.execute ? "已允许" : "未允许") : "未读取"}</dd></div><div><dt>重启后保留授权</dt><dd>${known ? (config.remember ? "已开启" : "未开启") : "未读取"}</dd></div></dl><h4>授权项目</h4><ul>${known && config.projects.length ? config.projects.map((id) => `<li>${esc(names.get(id) || id)}</li>`).join("") : `<li class="muted">${known ? "尚未授权项目" : "读取中"}</li>`}</ul></section>`;
}
export function mcpSettingsPanel(project, projects = [], config = {}) {
  return `<div id="settings-mcp" class="mcp-settings"><p class="notice">仅在本机运行。使用 MCP 时请保持本工具打开；不会自动联系任何 Agent。</p><div id="mcp-live-summary">${mcpStatusMarkup(config, projects)}</div><section class="mcp-access-card"><div class="row"><h2 class="grow">接入配置</h2><button id="mcp-config" class="primary">编辑授权与服务</button></div><p class="muted">权限、项目、密钥重置与持久授权均需在确认窗口中显式应用；此页不会自动扩大授权。</p><div class="mcp-client-section"><h3>客户端配置</h3><p class="muted">只在本机显示或复制。客户端仍需自行批准连接；尚未逐客户端实机验证。</p><div class="mcp-client-tabs" role="tablist" aria-label="MCP 客户端">${mcpClients.map((c, i) => `<button role="tab" aria-selected="${i === 0}" aria-controls="mcp-inline-code" data-mcp-preview-client="${esc(c)}" ${i === 0 ? 'class="active"' : ""}>${esc(c)}</button>`).join("")}</div><pre id="mcp-inline-code" role="tabpanel" aria-label="客户端连接配置">${hidden}</pre><div class="toolbar"><button id="mcp-reveal-config" ${config.enabled ? "" : "disabled"}>查看本机配置</button><button id="mcp-copy-config" disabled>复制配置</button></div><p id="mcp-panel-message" class="muted" role="status"></p></div><details><summary>stdio 独立授权方式</summary><p>HTTP 开关不代替 stdio 权限。stdio 默认只读，必须显式指定项目；需要写入或执行时分别添加 --write / --execute。</p><pre>node src/mcp.mjs --project ${esc(project.id)}</pre></details></section></div>`;
}
export function bindMCPSettings(root, { projects, loadConfig, copy, initial }) {
  let selected = "Cursor",
    preview = null,
    sequence = 0,
    loading = false,
    currentConfig = initial;
  const find = (s) => root.querySelector(s);
  const code = find("#mcp-inline-code"),
    reveal = find("#mcp-reveal-config"),
    copyButton = find("#mcp-copy-config"),
    message = find("#mcp-panel-message");
  function paint() {
    code.textContent = preview
      ? clientConfiguration(selected, preview)
      : hidden;
    reveal.textContent = preview ? "隐藏配置" : "查看本机配置";
    copyButton.disabled = !preview || loading;
    reveal.disabled = !currentConfig.enabled || (loading && !preview);
  }
  function update(config) {
    if (!root.isConnected) return;
    currentConfig = config;
    find("#mcp-live-summary").innerHTML = mcpStatusMarkup(config, projects);
    reveal.disabled = !config.enabled || loading;
    if (
      preview &&
      (!config.enabled ||
        config.token !== preview.token ||
        config.endpoint !== preview.endpoint)
    ) {
      preview = null;
      loading = false;
      sequence++;
      message.textContent = "连接配置已变更，旧密钥已从页面隐藏。";
    }
    paint();
  }
  for (const tab of root.querySelectorAll("[data-mcp-preview-client]")) {
    tab.tabIndex = tab.dataset.mcpPreviewClient === selected ? 0 : -1;
    tab.onkeydown = (event) => {
      if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      const tabs = [...root.querySelectorAll("[data-mcp-preview-client]")];
      const i = tabs.indexOf(tab);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (i + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
              tabs.length;
      tabs[next].focus();
      tabs[next].onclick();
    };
    tab.onclick = () => {
      selected = tab.dataset.mcpPreviewClient;
      for (const item of root.querySelectorAll("[data-mcp-preview-client]")) {
        item.setAttribute("aria-selected", String(item === tab));
        item.tabIndex = item === tab ? 0 : -1;
        item.classList.toggle("active", item === tab);
      }
      paint();
    };
  }
  reveal.onclick = async () => {
    if (preview) {
      preview = null;
      loading = false;
      sequence++;
      message.textContent = "配置已隐藏。";
      paint();
      return;
    }
    const current = ++sequence;
    loading = true;
    reveal.disabled = true;
    copyButton.disabled = true;
    try {
      const config = await loadConfig();
      if (!root.isConnected || current !== sequence) return;
      currentConfig = config;
      if (!config.enabled || !config.token)
        throw Error("MCP 服务已关闭，请先显式开启并授权项目。");
      preview = { endpoint: config.endpoint, token: config.token };
      message.textContent = "配置含连接密钥，仅粘贴到可信客户端。";
    } catch (error) {
      if (root.isConnected && current === sequence)
        message.textContent = error.message;
    } finally {
      if (root.isConnected && current === sequence) {
        loading = false;
        reveal.disabled = false;
        paint();
      }
    }
  };
  copyButton.onclick = async () => {
    if (!preview || loading) return;
    const current = ++sequence;
    loading = true;
    copyButton.disabled = true;
    try {
      const config = await loadConfig();
      if (!root.isConnected || current !== sequence) return;
      currentConfig = config;
      if (
        !config.enabled ||
        config.token !== preview.token ||
        config.endpoint !== preview.endpoint
      ) {
        preview = null;
        throw Error("连接配置已变更，请重新查看后复制。");
      }
      await copy(clientConfiguration(selected, preview));
      if (root.isConnected && current === sequence)
        message.textContent = "已复制到本机剪贴板。";
    } catch (error) {
      if (root.isConnected && current === sequence)
        message.textContent = error.message;
    } finally {
      if (root.isConnected && current === sequence) {
        loading = false;
        paint();
      }
    }
  };
  update(initial);
  return update;
}
