export function clippedRequestTab(tab, viewport) {
  return tab.left < viewport.left - 1 || tab.right > viewport.right + 1;
}

export function requestParameterOverflowHTML() {
  return `<div class="http-request-overflow" hidden>
    <button type="button" id="http-request-overflow-toggle" class="ghost" aria-label="更多请求参数标签" aria-haspopup="menu" aria-expanded="false" aria-controls="http-request-overflow-menu" title="更多请求参数标签"><span aria-hidden="true">⋯</span></button>
    <div id="http-request-overflow-menu" popover="auto" role="menu" aria-label="更多请求参数标签"></div>
  </div>`;
}

export function bindHTTPRequestParameterOverflow(editor, { select, onError }) {
  const strip = editor.querySelector(":scope > .param-tabs");
  const holder = editor.querySelector(".http-request-overflow");
  const trigger = holder.querySelector("button");
  const menu = holder.querySelector('[role="menu"]');
  const panel = editor.querySelector(":scope > .request-panel");
  const doc = editor.ownerDocument;
  const win = doc.defaultView;
  const controller = new AbortController();
  const { signal } = controller;
  const listen = (el, event, fn) => el.addEventListener(event, fn, { signal });
  const tabs = [...strip.querySelectorAll("[data-param]")];
  const opened = () => menu.matches(":popover-open");
  const clipped = () => {
    const viewport = strip.getBoundingClientRect();
    return tabs.filter((tab) =>
      clippedRequestTab(tab.getBoundingClientRect(), viewport),
    );
  };
  const options = () => [...menu.querySelectorAll("[data-overflow-param]")];
  const focus = (target) => target?.focus({ preventScroll: true });
  const close = (returnFocus) => {
    if (opened()) menu.hidePopover();
    trigger.setAttribute("aria-expanded", "false");
    if (returnFocus)
      focus(holder.hidden ? strip.querySelector(".active") : trigger);
  };
  const place = () => {
    if (!opened()) return;
    const box = trigger.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    const view = doc.documentElement;
    const left = Math.max(
      8,
      Math.min(box.left - 8, view.clientWidth - bounds.width - 8),
    );
    let top = box.bottom + 5;
    if (top + bounds.height > view.clientHeight - 8)
      top = Math.max(8, box.top - bounds.height - 5);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  };
  const populate = () => {
    const hidden = clipped();
    const focused = doc.activeElement?.dataset?.overflowParam;
    const prior = options();
    if (
      hidden.length !== prior.length ||
      hidden.some(
        (tab, index) =>
          tab.dataset.param !== prior[index]?.dataset.overflowParam,
      )
    ) {
      menu.replaceChildren(
        ...hidden.map((tab) => {
          const option = doc.createElement("button");
          option.type = "button";
          option.tabIndex = -1;
          option.className = "ghost";
          option.setAttribute("role", "menuitemradio");
          option.setAttribute("aria-checked", tab.getAttribute("aria-pressed"));
          option.dataset.overflowParam = tab.dataset.param;
          option.textContent = tab.textContent;
          return option;
        }),
      );
      if (focused)
        focus(
          options().find(
            (option) => option.dataset.overflowParam === focused,
          ) || options()[0],
        );
    } else {
      // Live tab labels can change without changing which tabs are clipped.
      prior.forEach((option, index) => {
        const tab = hidden[index];
        const checked = tab.getAttribute("aria-pressed");
        if (option.getAttribute("aria-checked") !== checked)
          option.setAttribute("aria-checked", checked);
        if (option.textContent !== tab.textContent)
          option.textContent = tab.textContent;
      });
    }
    return hidden.length > 0;
  };
  const sync = () => {
    if (!editor.isConnected) return;
    const split = editor.classList.contains("split-layout");
    // Compare with the entire request column, not the already reserved strip.
    // This prevents disclosure/no-disclosure from alternately changing the answer.
    const visible = split && strip.scrollWidth > panel.clientWidth + 1;
    const active = doc.activeElement;
    holder.hidden = !visible;
    editor.toggleAttribute("data-request-overflow-visible", visible);
    if (!visible && (opened() || active === trigger || menu.contains(active)))
      close(true);
    else if (!visible) close(false);
    else if (opened()) {
      if (!populate()) close(true);
      else place();
    }
  };
  const open = (last = false) => {
    sync();
    if (holder.hidden || !populate() || opened()) return;
    menu.showPopover();
    trigger.setAttribute("aria-expanded", "true");
    place();
    const choices = options();
    focus(
      last
        ? choices.at(-1)
        : choices.find(
            (option) => option.getAttribute("aria-checked") === "true",
          ) || choices[0],
    );
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
  listen(menu, "click", (event) => {
    const choice = event.target.closest("[data-overflow-param]");
    if (!choice || !opened() || holder.hidden) return;
    try {
      select(choice.dataset.overflowParam);
    } catch (error) {
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
    const choices = options();
    if (!choices.length) return;
    const current = choices.indexOf(doc.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? choices.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) %
            choices.length;
    focus(choices[next]);
  });
  listen(strip, "scroll", sync);
  listen(win, "resize", sync);
  const observer = new win.ResizeObserver(sync);
  for (const item of [strip, panel, ...tabs]) observer.observe(item);
  sync();
  return () => {
    observer.disconnect();
    controller.abort();
    close(false);
  };
}
