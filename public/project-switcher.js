import { icon } from "./icons.js";

export const selectableProjects = (projects) =>
  projects.filter((project) => !project.archived && !project.error);

export const matchesProjectName = (name, query) =>
  String(name ?? "")
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());

export function projectSwitcherHTML(disabled) {
  return `<button type="button" id="project-search-trigger" class="ghost" aria-label="搜索项目" title="搜索项目" aria-haspopup="dialog" aria-controls="project-search-popup" aria-expanded="false"${disabled ? " disabled" : ""}>${icon("search")}</button><section id="project-search-popup" popover role="dialog" aria-label="搜索项目"><label class="project-search-field">${icon("search")}<input type="search" id="project-name-search" aria-label="项目名称" placeholder="请输入项目名称" autocomplete="off"></label><ul id="project-search-results" aria-label="匹配项目"></ul><p class="project-search-status" role="status"></p></section>`;
}

export function bindProjectSwitcher(
  group,
  { projects, current, allowed, open, notify },
) {
  const trigger = group?.querySelector("#project-search-trigger");
  const panel = group?.querySelector("#project-search-popup");
  if (!trigger || !panel) return;
  const input = panel.querySelector("#project-name-search");
  const results = panel.querySelector("#project-search-results");
  const status = panel.querySelector(".project-search-status");
  const items = selectableProjects(projects);
  const visible = () => panel.matches(":popover-open");
  const buttons = () => [...results.querySelectorAll("button")];

  const draw = () => {
    const matches = items.filter(({ name }) =>
      matchesProjectName(name, input.value),
    );
    results.replaceChildren();
    for (const { id, name } of matches) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.projectSearchId = id;
      if (id === current) button.setAttribute("aria-current", "true");
      const label = document.createElement("span");
      label.textContent = name;
      button.innerHTML = icon("folder");
      button.append(label);
      row.append(button);
      results.append(row);
    }
    // The reference has no visible row when there are no matches. Announce that
    // outcome without introducing a fake selectable placeholder or leaking paths.
    status.textContent = matches.length ? "" : "没有匹配的项目";
  };
  const close = (focus = false) => {
    if (visible()) panel.hidePopover();
    if (focus && trigger.isConnected) trigger.focus({ preventScroll: true });
  };
  panel.addEventListener("beforetoggle", (event) => {
    const opening = event.newState === "open";
    trigger.setAttribute("aria-expanded", String(opening));
    if (!opening) {
      input.value = "";
      results.replaceChildren();
      status.textContent = "";
    }
  });
  trigger.addEventListener("click", () => {
    if (visible()) return close(true);
    if (!allowed() || !group.isConnected) return;
    input.value = "";
    draw();
    panel.showPopover();
    input.focus({ preventScroll: true });
  });
  input.addEventListener("input", draw);
  panel.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (next && next !== trigger && !panel.contains(next)) close();
  });
  panel.addEventListener("keydown", (event) => {
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
      return;
    }
    const rows = buttons();
    if (!rows.length) return;
    const at = rows.indexOf(event.target);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      (rows[at + 1] || input).focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (at < 0 ? rows.at(-1) : rows[at - 1] || input).focus();
    } else if (event.target === input && event.key === "Enter") {
      event.preventDefault();
      rows[0].click();
    }
  });
  results.addEventListener("click", async (event) => {
    const id = event.target.closest("[data-project-search-id]")?.dataset
      .projectSearchId;
    if (!id || !visible() || !group.isConnected || !allowed()) return;
    close(true);
    if (id === current) return;
    try {
      await open(id);
    } catch (error) {
      notify(error.message);
    }
  });
}
