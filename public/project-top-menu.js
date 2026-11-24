import { icon } from "./icons.js";

export function projectTopMenu(disabled) {
  return `<button type="button" id="new-project" class="ghost" aria-haspopup="dialog" aria-controls="project-top-menu" aria-expanded="false"${disabled ? " disabled" : ""}>＋ 新建/导入项目</button><section id="project-top-menu" popover role="dialog" aria-label="新建或导入项目"><button type="button" id="project-menu-create">${icon("copy-request")}新建项目</button><button type="button" id="project-menu-import">${icon("folder")}导入项目</button></section>`;
}

export function bindProjectTopMenu(trigger, panel, allowed) {
  if (!trigger || !panel) return;
  const buttons = [...panel.querySelectorAll("button")];
  const shown = () => panel.matches(":popover-open");
  const dismiss = () => {
    if (shown()) panel.hidePopover();
    if (trigger.isConnected) trigger.focus({ preventScroll: true });
  };
  trigger.addEventListener("click", (event) => {
    if (shown()) return dismiss();
    if (!trigger.isConnected || !allowed()) return;
    const anchor = trigger.getBoundingClientRect();
    panel.style.setProperty("--project-menu-start", anchor.left + "px");
    const headerBottom =
      trigger.closest("header")?.getBoundingClientRect().bottom ??
      anchor.bottom;
    panel.style.setProperty(
      "--project-menu-top",
      Math.max(anchor.bottom + 6, headerBottom + 1) + "px",
    );
    panel.showPopover();
    if (event.detail === 0) buttons[0].focus({ preventScroll: true });
  });
  panel.addEventListener("beforetoggle", (event) => {
    trigger.setAttribute("aria-expanded", String(event.newState === "open"));
  });
  panel.addEventListener(
    "click",
    (event) => {
      if (event.target.closest("button")) dismiss();
    },
    true,
  );
  const key = (event) => {
    if (!shown()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const from = buttons.indexOf(event.target);
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? 1
            : from < 0
              ? Number(event.key === "ArrowUp")
              : 1 - from;
      buttons[index].focus({ preventScroll: true });
    } else if (
      (event.ctrlKey || event.metaKey) &&
      ["s", "Enter"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  panel.addEventListener("keydown", key);
  trigger.addEventListener("keydown", key);
}
