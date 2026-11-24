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

export function rawHelperVariableNames(project, environmentId, request) {
  if (request !== undefined && !project.requests?.includes(request))
    throw Error("当前请求不属于此项目，未读取变量");
  const environment = project.environments?.find(
    (item) => item.id === environmentId,
  );
  const names = new Map(
    Object.keys(project.globalVariables || {}).map((name) => [
      name,
      "全局变量",
    ]),
  );
  const collectionId = request?.postmanCollectionId;
  if (collectionId !== undefined) {
    // Use only the current owned request's live collection entries, not its
    // definitions/initial values or other collections. Debug precedence is
    // global < owning collection < active environment.
    const collection = project.postmanCollections?.items?.find(
      (item) => item.id === collectionId,
    );
    if (!collection) throw Error("当前请求的 Postman 集合不可用");
    for (const name of Object.keys(collection.variables))
      names.set(name, "集合变量");
  }
  for (const name of Object.keys(environment?.variables || {}))
    names.set(name, "环境变量");
  return Array.from(names, ([name, scope]) => ({ name, scope }));
}

export function rawHelperVariableChooser(entries) {
  return `<div class="raw-helper-variable-chooser">
    <label for="raw-helper-variable-search">变量名</label>
    <input id="raw-helper-variable-search" type="search" placeholder="请输入或选择变量名" aria-describedby="raw-helper-variable-scope-note" autocomplete="off">
    <div class="raw-helper-variable-options" role="group" aria-label="可引用的变量">
      ${entries.map(({ name, scope }) => `<button type="button" data-raw-variable-name="${esc(name)}" aria-pressed="false"><span>${esc(name)}</span><small>${esc(scope)}</small></button>`).join("")}
      <p role="status"${entries.length ? " hidden" : ""}>当前项目没有可引用的变量</p>
    </div>
    <p id="raw-helper-variable-scope-note">仅列出已配置的变量名；运行时作用域可能变化。</p>
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
  return `<div class="raw-helper-fixed-chooser raw-helper-preset">
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

const rawHelperMockGroups = [
  [
    "数值与布尔",
    [
      ["integer", "整数", "@integer(1,100)", "integer"],
      ["boolean", "布尔值", "@boolean()", "boolean"],
    ],
  ],
  [
    "日期",
    [
      ["date", "日期（年-月-日）", "@date()", "string"],
      ["datetime", "ISO 日期时间（UTC 午夜）", "@datetime()", "string"],
    ],
  ],
  ["标识", [["uuid", "UUID", "@uuid()", "string"]]],
  [
    "网络与邮箱",
    [
      ["url", "示例网址", "@url()", "string"],
      ["ip", "示例 IPv4", "@ip()", "string"],
      ["email", "示例邮箱", "@email()", "string"],
    ],
  ],
  [
    "姓名和文本",
    [
      ["cname", "中文姓名", "@cname()", "string"],
      ["name", "英文姓名", "@name()", "string"],
      ["word", "8 位小写字母", "@word(8)", "string"],
    ],
  ],
];
const mockRules = new Map(
  rawHelperMockGroups.flatMap(([, items]) =>
    items.map(([id, , value, type]) => [id, { value, type }]),
  ),
);

export function rawHelperMockPreset(id) {
  const rule = mockRules.get(id);
  return rule
    ? { spec: { source: "mock", ...rule, format: "json", functions: [] } }
    : null;
}

export function rawHelperMockChooser() {
  return `<div class="raw-helper-mock-chooser raw-helper-preset">
    <label for="raw-helper-mock-search">Mock 规则</label>
    <input id="raw-helper-mock-search" type="search" placeholder="搜索已支持的规则" autocomplete="off">
    <div class="raw-helper-mock-groups">
      <p>Workbench 内置规则，仅在实际发送时生成。</p>
      ${rawHelperMockGroups
        .map(
          ([group, items]) =>
            `<details data-raw-mock-group="${esc(group)}"><summary>${esc(group)}</summary>${items
              .map(
                ([id, label, expr]) =>
                  `<button type="button" data-raw-mock-rule="${esc(id)}" aria-pressed="false"><span>${esc(label)}</span><code>${esc(expr)}</code></button>`,
              )
              .join("")}</details>`,
        )
        .join("")}
      <p class="raw-helper-mock-status" role="status" hidden>没有匹配的内置规则</p>
    </div>
    <div class="raw-helper-mock-result">
      <label for="raw-helper-mock-expression">表达式</label>
      <input id="raw-helper-mock-expression" readonly>
    </div>
  </div>`;
}

export function bindRawHelperMockChooser(chooser, id, confirm, cancel) {
  const search = chooser.querySelector("input[type=search]");
  const token = chooser.querySelector("#raw-helper-mock-expression");
  const groups = Array.from(chooser.querySelectorAll("details"));
  const rows = Array.from(chooser.querySelectorAll("[data-raw-mock-rule]"));
  const status = chooser.querySelector(".raw-helper-mock-status");
  const openBeforeFilter = new Map();
  let selected,
    filtering = false;
  const select = (row) => {
    selected = row;
    confirm.disabled = !row;
    token.value = row ? bodyDynamicToken(id) : "";
    for (const item of rows)
      item.setAttribute("aria-pressed", String(item === row));
  };
  select(null);
  for (const row of rows) row.addEventListener("click", () => select(row));
  search.addEventListener("input", () => {
    const term = search.value.trim().toLowerCase();
    if (term && !filtering)
      for (const group of groups) openBeforeFilter.set(group, group.open);
    for (const group of groups) {
      const name = group.dataset.rawMockGroup.toLowerCase();
      const entries = Array.from(group.querySelectorAll("button"));
      for (const row of entries)
        row.hidden = Boolean(
          term &&
            !name.includes(term) &&
            !row.textContent.toLowerCase().includes(term),
        );
      group.hidden = entries.every((row) => row.hidden);
      if (term) group.open = !group.hidden;
      else if (filtering) group.open = openBeforeFilter.get(group) ?? false;
    }
    filtering = Boolean(term);
    if (selected?.hidden) select(null);
    status.hidden = groups.some((group) => !group.hidden);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.preventDefault();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel.click();
    }
    if (event.key === "ArrowDown") {
      const row = rows.find(
        (item) => !item.hidden && item.closest("details").open,
      );
      if (row) {
        event.preventDefault();
        row.focus();
      }
    }
  });
  return () => rawHelperMockPreset(selected?.dataset.rawMockRule);
}
