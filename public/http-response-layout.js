import { focusHTTPBodyModeAfterLayout } from "./http-body-modes.js";
import { icon } from "./icons.js";

const layoutOptions = [
  ["stacked", "上下分屏", "workspace-stack"],
  ["split", "左右分屏", "workspace-split"],
];

export const responseLayoutMedia = "(min-width: 760px)";

export function effectiveResponseLayout(preferred, wide) {
  return preferred === "split" && wide ? "split" : "stacked";
}

export function httpResponseLayoutHTML(parked) {
  return `<div class="http-response-layout-control${parked ? " http-response-layout-parked" : ""}">
    <button type="button" id="http-response-layout-toggle" class="ghost" aria-haspopup="menu" aria-expanded="false" aria-controls="http-response-layout-menu" aria-label="请求和响应布局" title="请求和响应布局">${icon("workspace-stack")}</button>
    <div id="http-response-layout-menu" popover="auto" role="menu" aria-label="选择请求和响应布局">${layoutOptions.map(([value, label, mark]) => `<button type="button" role="menuitemradio" aria-checked="false" tabindex="-1" class="ghost" data-http-layout="${value}">${icon(mark)}<span>${label}</span></button>`).join("")}</div>
  </div>`;
}

export function bindHTTPResponseLayout({
  editor,
  fallback,
  media,
  preferred,
  writePreference,
  onLayoutChange,
  onError,
}) {
  const win = editor.ownerDocument.defaultView;
  const controller = new AbortController();
  const { signal } = controller;
  const trigger = editor.querySelector("#http-response-layout-toggle");
  const menu = editor.querySelector("#http-response-layout-menu");
  const options = [...menu.querySelectorAll("[data-http-layout]")];
  const splitOption = options[1];
  const listen = (target, name, handler) =>
    target.addEventListener(name, handler, { signal });
  const opened = () => menu.matches(":popover-open");
  const preferredLayout = () =>
    effectiveResponseLayout(preferred(), media.matches);
  const place = () => {
    if (!opened()) return;
    const box = trigger.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    const right = Number(editor.ownerDocument.documentElement.clientWidth);
    const bottom = Number(editor.ownerDocument.documentElement.clientHeight);
    menu.style.left =
      Math.max(
        8,
        Math.min(box.left - bounds.width - 12, right - bounds.width - 8),
      ) + "px";
    menu.style.top =
      Math.max(
        8,
        Math.min(
          box.top + (box.height - bounds.height) / 2,
          bottom - bounds.height - 8,
        ),
      ) + "px";
  };
  const update = () => {
    const layout = preferredLayout();
    const split = layout === "split";
    const switched = editor.classList.contains("split-layout") !== split;
    const active = editor.ownerDocument.activeElement;
    editor.classList.toggle("split-layout", split);
    if (switched) focusHTTPBodyModeAfterLayout(editor, active, split);
    for (const option of options)
      option.setAttribute(
        "aria-checked",
        String(option.dataset.httpLayout === layout),
      );
    splitOption.disabled = !media.matches;
    splitOption.title = media.matches ? "" : "加宽窗口后可使用左右分屏";
    fallback.textContent = split ? "上下布局" : "左右布局";
    fallback.disabled = !media.matches;
    fallback.setAttribute("aria-pressed", String(split));
    trigger.innerHTML = icon(split ? "workspace-split" : "workspace-stack");
    place();
  };
  const close = (restoreFocus) => {
    if (opened()) menu.hidePopover();
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus({ preventScroll: true });
  };
  const open = () => {
    if (opened()) return;
    menu.showPopover();
    trigger.setAttribute("aria-expanded", "true");
    place();
    options
      .find((option) => option.getAttribute("aria-checked") === "true")
      ?.focus({ preventScroll: true });
  };
  const choose = (value) => {
    if (value === "split" && !media.matches) return;
    try {
      if (value !== preferred()) writePreference(value);
      update();
      onLayoutChange?.();
    } catch (error) {
      onError?.(error);
    }
  };
  listen(trigger, "click", () => (opened() ? close(true) : open()));
  listen(trigger, "keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    open();
  });
  listen(menu, "toggle", () =>
    trigger.setAttribute("aria-expanded", String(opened())),
  );
  for (const option of options)
    listen(option, "click", () => choose(option.dataset.httpLayout));
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
    const available = options.filter((option) => !option.disabled);
    const current = available.indexOf(editor.ownerDocument.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? available.length - 1
          : (current +
              (event.key === "ArrowDown" ? 1 : -1) +
              available.length) %
            available.length;
    available[next]?.focus({ preventScroll: true });
  });
  listen(fallback, "click", () =>
    choose(preferredLayout() === "split" ? "stacked" : "split"),
  );
  listen(media, "change", () => {
    const focused = editor.ownerDocument.activeElement;
    update();
    if (opened() && focused === splitOption && splitOption.disabled)
      options[0].focus({ preventScroll: true });
  });
  listen(win, "resize", place);
  update();
  return () => {
    close(false);
    controller.abort();
  };
}
