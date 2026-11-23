const entries = [
  ["script", "自定义脚本", true],
  ["assertions", "打开断言", false],
  ["extract", "打开提取变量", false],
];

export function httpPostActionsHTML({ configured, advanced, open, hasScript }) {
  return `<section class="http-post-actions" aria-label="后执行操作工作区">
    ${configured}${hasScript ? '<p class="http-post-script-status">已配置后置 JavaScript</p>' : ""}
    <button type="button" id="http-post-add" class="ghost" aria-haspopup="menu" aria-expanded="false" aria-controls="http-post-menu"><span aria-hidden="true">＋</span> 添加操作项</button>
    <div id="http-post-menu" popover="auto" role="menu" aria-label="添加操作项">${entries.map(([key, label, dialog]) => `<button type="button" class="ghost" role="menuitem" tabindex="-1" data-post-action="${key}"${dialog ? ' aria-haspopup="dialog"' : ""}>${label}</button>`).join("")}</div>
    <details id="http-post-advanced"${open ? " open" : ""}><summary>脚本与高级设置</summary>${advanced}</details>
    <p class="http-post-safety">脚本在沙箱运行；数据库只读操作需要单独授权。</p>
  </section>`;
}

export function bindHTTPPostActions(panel, { choose, onError }) {
  return bindHTTPActionMenu(panel, {
    triggerSelector: "#http-post-add",
    menuSelector: "#http-post-menu",
    actionAttribute: "data-post-action",
    choose,
    onError,
  });
}

export function bindHTTPActionMenu(
  panel,
  { triggerSelector, menuSelector, actionAttribute, choose, onError },
) {
  const trigger = panel.querySelector(triggerSelector);
  const menu = panel.querySelector(menuSelector);
  const options = [...menu.querySelectorAll("[" + actionAttribute + "]")];
  const doc = panel.ownerDocument;
  const win = doc.defaultView;
  const controller = new AbortController();
  const { signal } = controller;
  const listen = (el, event, listener) =>
    el.addEventListener(event, listener, { signal });
  const opened = () => menu.matches(":popover-open");
  const focus = (element) => element?.focus({ preventScroll: true });
  const close = (returnFocus) => {
    if (opened()) menu.hidePopover();
    trigger.setAttribute("aria-expanded", "false");
    if (returnFocus) focus(trigger);
  };
  const place = () => {
    if (!opened()) return;
    const anchor = trigger.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    const viewport = doc.documentElement;
    const left = anchor.left + (anchor.width - bounds.width) / 2;
    let top = anchor.bottom + 12;
    if (top + bounds.height > viewport.clientHeight - 8)
      top = Math.max(8, anchor.top - bounds.height - 12);
    menu.style.left =
      Math.max(8, Math.min(left, viewport.clientWidth - bounds.width - 8)) +
      "px";
    menu.style.top = top + "px";
  };
  const open = (last = false) => {
    if (opened()) return;
    menu.showPopover();
    trigger.setAttribute("aria-expanded", "true");
    place();
    focus(last ? options.at(-1) : options[0]);
  };
  listen(trigger, "click", () => (opened() ? close(true) : open()));
  listen(trigger, "keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    open(event.key === "ArrowUp");
  });
  listen(menu, "toggle", () =>
    trigger.setAttribute("aria-expanded", String(opened())),
  );
  for (const option of options)
    listen(option, "click", () => {
      if (!opened() || !panel.isConnected) return;
      close(false);
      try {
        choose(option.getAttribute(actionAttribute));
      } catch (error) {
        focus(trigger);
        onError(error);
      }
    });
  listen(menu, "keydown", (event) => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = options.indexOf(doc.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
            options.length;
    focus(options[next]);
  });
  listen(win, "resize", place);
  return () => {
    close(false);
    controller.abort();
  };
}
