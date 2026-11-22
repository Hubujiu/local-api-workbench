import { icon } from "./icons.js";

export function bindApiRowMenu(tree, { prepare, notify }) {
  const menu = tree?.querySelector("#api-tree-row-menu");
  if (!menu) return;
  menu.innerHTML = `<button type="button" role="menuitem" tabindex="-1" data-api-row-action="clone">${icon("copy-request")}克隆</button><div role="separator"></div><button type="button" role="menuitem" tabindex="-1" data-api-row-action="trash">${icon("♲")}删除</button>`;
  const items = [...menu.querySelectorAll("[data-api-row-action]")];
  const open = () => menu.matches(":popover-open");
  let trigger, run;
  const clear = () => {
    trigger?.setAttribute("aria-expanded", "false");
    trigger = run = undefined;
  };
  const close = (focus = false) => {
    const previous = trigger;
    if (open()) menu.hidePopover();
    clear();
    if (focus && previous?.isConnected) previous.focus({ preventScroll: true });
  };
  const show = (button, index = 0) => {
    if (!tree.isConnected || !button.isConnected) return;
    if (open() && trigger === button) return close(true);
    close();
    try {
      run = prepare(button.dataset.apiRowMenu);
      trigger = button;
      button.setAttribute("aria-expanded", "true");
      menu.showPopover();
      items[index].focus({ preventScroll: true });
    } catch (error) {
      close();
      notify(error.message);
    }
  };
  menu.addEventListener("toggle", () => {
    if (!open()) clear();
  });
  for (const button of tree.querySelectorAll("[data-api-row-menu]")) {
    button.addEventListener("click", () => show(button));
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      show(button, event.key === "ArrowUp" ? items.length - 1 : 0);
    });
  }
  menu.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      ["s", "Enter"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close(true);
    } else {
      const current = items.indexOf(event.target);
      const index = {
        Home: 0,
        End: items.length - 1,
        ArrowDown: (current + 1) % items.length,
        ArrowUp: (current + items.length - 1) % items.length,
      }[event.key];
      if (!Number.isInteger(index)) return;
      event.preventDefault();
      items[index].focus({ preventScroll: true });
    }
  });
  menu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-api-row-action]");
    if (!item || !open() || !trigger?.isConnected || !tree.isConnected) return;
    const button = trigger,
      invoke = run;
    close(true);
    try {
      invoke(item.dataset.apiRowAction, button);
    } catch (error) {
      notify(error.message);
    }
  });
}
