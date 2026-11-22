import { escapeCode as esc } from "./code-format.js";

const tabs = [
  ["dictionary", "字典库"],
  ["dynamic", "动态值"],
];

const searchableValues = (entry) =>
  [entry.key, entry.note, entry.description].filter(
    (value) => typeof value === "string",
  );

export function matchesRawHelperEntry(entry, query) {
  const term = query.trim().toLowerCase();
  return (
    !term ||
    searchableValues(entry).some((value) => value.toLowerCase().includes(term))
  );
}

export function rawHelperTabs(entries, dynamicHTML, state) {
  return `<div role="tablist" class="raw-helper-tabs" aria-label="参数助手类别">${tabs
    .map(([value, label]) => {
      const active = value === state.tab;
      return `<button type="button" role="tab" id="raw-helper-tab-${value}" data-raw-helper-tab="${value}" aria-controls="raw-helper-${value}" aria-selected="${active}" tabindex="${active ? 0 : -1}">${label}</button>`;
    })
    .join("")}</div>
    <div id="raw-helper-dictionary" role="tabpanel" aria-labelledby="raw-helper-tab-dictionary" ${state.tab === "dictionary" ? "" : "hidden"}>
      <input type="search" id="raw-helper-filter" aria-label="搜索参数、备注或描述" placeholder="参数/备注/描述" value="${esc(state.query)}">
      <div class="raw-helper-entries">${entries
        .map(
          (entry) =>
            `<button type="button" data-insert-dictionary="${esc(entry.id)}" data-raw-helper-query="${esc(JSON.stringify(searchableValues(entry)))}" title="${esc(entry.description || entry.note || entry.key)}" ${matchesRawHelperEntry(entry, state.query) ? "" : "hidden"}><span>${esc(entry.key)}</span><span>${esc(entry.description || entry.note || entry.type)}</span></button>`,
        )
        .join("")}</div>
      <p class="raw-helper-empty" role="status"${entries.some((entry) => matchesRawHelperEntry(entry, state.query)) ? " hidden" : ""}>${entries.length ? "没有匹配的字典参数" : "当前项目暂无字典参数"}</p>
    </div>
    <div id="raw-helper-dynamic" role="tabpanel" aria-labelledby="raw-helper-tab-dynamic" ${state.tab === "dynamic" ? "" : "hidden"}>${dynamicHTML}</div>`;
}

export function bindRawHelper(panel, state) {
  if (!panel) return;
  const buttons = Array.from(panel.querySelectorAll("[data-raw-helper-tab]"));
  const bodies = Array.from(panel.querySelectorAll('[role="tabpanel"]'));
  const filter = panel.querySelector("#raw-helper-filter");
  const rows = Array.from(
    panel.querySelectorAll("[data-raw-helper-query]"),
  ).map((row) => ({
    row,
    fields: JSON.parse(row.dataset.rawHelperQuery),
  }));
  const status = panel.querySelector(".raw-helper-empty");
  const select = (button, focus = false) => {
    state.tab = button.dataset.rawHelperTab;
    for (const current of buttons) {
      const active = current === button;
      current.setAttribute("aria-selected", String(active));
      current.tabIndex = active ? 0 : -1;
    }
    for (const body of bodies)
      body.hidden = body.id !== button.getAttribute("aria-controls");
    if (focus) button.focus();
  };
  for (const [index, button] of buttons.entries()) {
    button.addEventListener("click", () => select(button));
    button.addEventListener("keydown", (event) => {
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : event.key === "ArrowLeft"
              ? (index + buttons.length - 1) % buttons.length
              : event.key === "ArrowRight"
                ? (index + 1) % buttons.length
                : -1;
      if (next < 0) return;
      event.preventDefault();
      select(buttons[next], true);
    });
  }
  filter.addEventListener("input", () => {
    state.query = filter.value;
    const term = state.query.trim().toLowerCase();
    let any = false;
    for (const { row, fields } of rows) {
      row.hidden = Boolean(
        term && !fields.some((value) => value.toLowerCase().includes(term)),
      );
      any ||= !row.hidden;
    }
    status.hidden = any;
    if (!any)
      status.textContent = rows.length
        ? "没有匹配的字典参数"
        : "当前项目暂无字典参数";
  });
}
