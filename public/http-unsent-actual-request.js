import { icon } from "./icons.js";

const sections = [
  ["header", "Header", "未定义请求头"],
  ["query", "Query", "未定义 URL 参数"],
  ["path", "Path", "未定义路径参数"],
  ["body", "Body", "未定义请求体"],
];
const knownMethods = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export function unsentActualRequestHTML(method, selected = "header") {
  if (!sections.some(([key]) => key === selected)) selected = "header";
  const badge = knownMethods.has(method)
    ? `<span class="method ${method}" title="编辑器所选方法，尚未发送">${method}</span>`
    : "";
  return `<section class="actual-request-unsent" aria-label="实际请求（未发送）">
    <h3>请求URL</h3>
    <div class="actual-request-unsent-method">${badge}<span>未发送</span></div>
    <h3>请求参数</h3>
    <div class="actual-request-unsent-tabs" role="tablist" aria-label="实际请求参数">
      ${sections.map(([key, title]) => `<button type="button" role="tab" id="actual-unsent-tab-${key}" data-actual-unsent-tab="${key}" aria-controls="actual-unsent-panel-${key}" aria-selected="${key === selected}" tabindex="${key === selected ? 0 : -1}">${title}</button>`).join("")}
    </div>
    ${sections
      .map(
        ([
          key,
          ,
          emptyText,
        ]) => `<div class="actual-request-unsent-panel" id="actual-unsent-panel-${key}" role="tabpanel" aria-labelledby="actual-unsent-tab-${key}" tabindex="0"${key === selected ? "" : " hidden"}>
      ${key === "body" ? '<p class="actual-request-unsent-body-type">类型:</p>' : ""}
      <div class="unsent-response-message"><span aria-hidden="true">${icon("body-empty")}</span><p>${emptyText}</p></div>
    </div>`,
      )
      .join("")}
  </section>`;
}

export function bindUnsentActualRequest(root, owns, remember) {
  const tabs = [...root.querySelectorAll("[data-actual-unsent-tab]")];
  const panels = [...root.querySelectorAll('[role="tabpanel"]')];

  const activate = (target) => {
    if (!root.isConnected || !owns() || !tabs.includes(target)) return;
    const key = target.dataset.actualUnsentTab;
    for (const tab of tabs) {
      const active = tab === target;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const panel of panels)
      panel.hidden = panel.id !== target.getAttribute("aria-controls");
    remember(key);
    target.focus();
  };
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : event.key === "ArrowLeft"
              ? (index + tabs.length - 1) % tabs.length
              : event.key === "ArrowRight"
                ? (index + 1) % tabs.length
                : -1;
      if (next < 0 || !root.isConnected || !owns()) return;
      event.preventDefault();
      activate(tabs[next]);
    });
  }
}
