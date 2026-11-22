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

export function rawHelperVariableNames(project, environmentId) {
  const environment = project.environments?.find(
    (item) => item.id === environmentId,
  );
  const names = new Map(
    Object.keys(project.globalVariables || {}).map((name) => [
      name,
      "全局变量",
    ]),
  );
  for (const name of Object.keys(environment?.variables || {}))
    names.set(name, "环境变量");
  return Array.from(names, ([name, scope]) => ({ name, scope }));
}

export function rawHelperVariableChooser(entries) {
  return `<div class="raw-helper-variable-chooser">
    <label for="raw-helper-variable-search">变量名</label>
    <input id="raw-helper-variable-search" type="search" placeholder="请输入或选择变量名" autocomplete="off">
    <div class="raw-helper-variable-options" role="group" aria-label="可引用的变量">
      ${entries.map(({ name, scope }) => `<button type="button" data-raw-variable-name="${esc(name)}" aria-pressed="false"><span>${esc(name)}</span><small>${esc(scope)}</small></button>`).join("")}
      <p role="status"${entries.length ? " hidden" : ""}>当前项目没有可引用的变量</p>
    </div>
  </div>`;
}

export function bindRawHelperVariableChooser(chooser, confirm, cancel) {
  const search = chooser.querySelector("input");
  const rows = Array.from(chooser.querySelectorAll("[data-raw-variable-name]"));
  const status = chooser.querySelector('[role="status"]');
  const visible = () => rows.filter((row) => !row.hidden);
  let selected = null;
  const select = (row) => {
    selected = row;
    confirm.disabled = !row;
    for (const item of rows)
      item.setAttribute("aria-pressed", String(item === row));
  };
  select(null);
  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    for (const row of rows)
      row.hidden = !row.dataset.rawVariableName.toLowerCase().includes(query);
    if (selected?.hidden) select(null);
    status.hidden = visible().length !== 0;
    if (rows.length) status.textContent = "没有匹配的变量";
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      // A search input can consume Escape to clear itself instead of closing.
      event.preventDefault();
      event.stopPropagation();
      cancel.click();
      return;
    }
    if (event.key === "Enter") event.preventDefault();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      visible()[0]?.focus();
    }
  });
  for (const row of rows) {
    row.addEventListener("click", () => select(row));
    row.addEventListener("keydown", (event) => {
      const items = visible();
      const index = items.indexOf(row);
      if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "ArrowUp" && index === 0) search.focus();
      else items[index + (event.key === "ArrowUp" ? -1 : 1)]?.focus();
    });
  }
  return () => selected?.dataset.rawVariableName;
}

export const bodyDynamicToken = (id) => `{{@value:${id}}}`;

export function rawHelperFixedValue(value) {
  if (typeof value !== "string" || !value.length) return null;
  const preview = JSON.stringify(value);
  if (new TextEncoder().encode(preview).length > 65536) return null;
  return {
    preview,
    spec: { source: "fixed", value, format: "json", functions: [] },
  };
}

export function rawHelperFixedChooser() {
  return `<div class="raw-helper-fixed-chooser">
    <label for="raw-helper-fixed-value">固定值</label>
    <input id="raw-helper-fixed-value" type="text" maxlength="65536" placeholder="输入固定文本" autocomplete="off">
    <p>以 JSON 字符串插入，不执行加工函数。</p>
    <div class="raw-helper-fixed-result">
      <label for="raw-helper-fixed-expression">表达式</label>
      <input id="raw-helper-fixed-expression" readonly>
      <label for="raw-helper-fixed-preview">预览</label>
      <input id="raw-helper-fixed-preview" readonly>
      <p role="status" hidden>固定值不能超过 64 KiB（按 JSON 编码计）</p>
    </div>
  </div>`;
}

export function bindRawHelperFixedChooser(chooser, id, confirm) {
  const input = chooser.querySelector("#raw-helper-fixed-value");
  const token = chooser.querySelector("#raw-helper-fixed-expression");
  const preview = chooser.querySelector("#raw-helper-fixed-preview");
  const status = chooser.querySelector("[role=status]");
  const update = () => {
    const value = rawHelperFixedValue(input.value);
    confirm.disabled = !value;
    token.value = value ? bodyDynamicToken(id) : "";
    preview.value = value?.preview || "";
    status.hidden = Boolean(value || !input.value.length);
  };
  input.addEventListener("input", update);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.preventDefault();
  });
  update();
  return () => rawHelperFixedValue(input.value);
}
