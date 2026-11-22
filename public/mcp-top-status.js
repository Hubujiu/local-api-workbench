export const isMCPActivityReceipt = (config) =>
  typeof config?.enabled === "boolean" && Array.isArray(config.activities);

export function mcpTopStatus(config, unavailable = false) {
  if (unavailable) return { kind: "unavailable", text: "MCP · 状态不可用" };
  if (!isMCPActivityReceipt(config))
    return { kind: "loading", text: "MCP · 读取中" };
  const running = config.activities.filter(
    (activity) => activity?.status === "running",
  ).length;
  // Shared local stdio activities can be present while the HTTP switch is off.
  return running
    ? { kind: "running", text: `MCP · ${running} 个任务运行中` }
    : config.enabled
      ? { kind: "enabled", text: "MCP · 已开启" }
      : { kind: "off", text: "MCP · 未开启" };
}

export function mcpTopStatusButton(config, unavailable) {
  const { kind, text } = mcpTopStatus(config, unavailable);
  return `<button type="button" id="mcp-status" data-page="settings" data-settings-target="settings-mcp" data-mcp-state="${kind}" title="打开 MCP 连接设置"><span id="mcp-top-status-text">${text}</span></button><span id="mcp-top-announcer" role="status" aria-live="polite" aria-atomic="true"></span>`;
}

export function updateMCPTopStatus(button, config, unavailable) {
  if (!button) return;
  const { kind, text } = mcpTopStatus(config, unavailable);
  if (button.dataset.mcpState !== kind) button.dataset.mcpState = kind;
  const label = button.querySelector("#mcp-top-status-text");
  if (label && label.textContent !== text) {
    label.textContent = text;
    const announcer = button.parentElement?.querySelector("#mcp-top-announcer");
    if (announcer) announcer.textContent = text;
  }
}
