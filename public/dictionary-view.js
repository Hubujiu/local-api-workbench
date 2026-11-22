const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const dictionaryIcon =
  '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor"><rect x="3" y="2.5" width="10" height="10" rx="1.2"/><path d="M6 9V6l4 3V6M5 14h7"/></svg>';
const emptyIcon =
  '<svg aria-hidden="true" viewBox="0 0 48 52" fill="none" stroke="currentColor"><path d="M9 23V4h29v19M14 11h19m-19 5h19m-19 5h13M9 23L2 30v20h44V30l-8-7m-36 7h13v7h18v-7h13m-38-3h10v7m22-7H30v7"/></svg>';
const dictionaryTabs = [
  ["custom", "自定义"],
  ["builtin", "系统内置"],
];

export function dictionarySidebar() {
  return `<nav class="dictionary-side-nav" aria-label="字典导航"><button type="button" data-dictionary-jump="dictionary-surface-heading" aria-current="location">${dictionaryIcon}数据字典</button><button type="button" data-dictionary-jump="dictionary-models-heading"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor"><circle cx="8" cy="4" r="2"/><circle cx="4" cy="11" r="2"/><circle cx="12" cy="11" r="2"/><path d="M7 6L5 9m4-3 2 3"/></svg>数据模型</button></nav>`;
}

export function dictionaryPanel(project, temporary = []) {
  const custom = project.parameterDictionary || [];
  const panel = (key, label) => {
    const isCustom = key === "custom";
    const entries = isCustom ? custom : builtinParameters;
    const rows = entries
      .map(
        (entry) =>
          `<tr data-dictionary-row><td><div class="dictionary-name-line"><span data-dictionary-match>${esc(entry.key)}</span><span class="dictionary-type">${esc(entry.type)}</span></div>${isCustom && entry.note ? `<small class="muted">${esc(entry.note)}</small>` : ""}</td><td data-dictionary-match>${esc(entry.description)}</td>${isCustom ? `<td>${esc(JSON.stringify(dictionaryValue(entry)))}</td><td><div class="dictionary-row-actions"><button type="button" data-edit-parameter-entry="${esc(entry.id)}">编辑</button><button type="button" data-delete-parameter-entry="${esc(entry.id)}">删除</button></div></td>` : ""}</tr>`,
      )
      .join("");
    return `<section id="dictionary-panel-${key}" data-dictionary-panel="${key}" role="tabpanel" aria-labelledby="dictionary-tab-${key}"${isCustom ? "" : " hidden"}><div class="dictionary-controls"><label class="dictionary-search"><span aria-hidden="true">⌕</span><input type="search" data-dictionary-search aria-label="搜索${label}参数名称或描述" placeholder="搜索参数名称或参数描述" autocomplete="off"></label>${isCustom ? '<div class="dictionary-actions"><button type="button" id="import-parameter-dictionary">导入字典</button><button type="button" id="new-parameter-entry" class="primary">新增参数</button></div>' : `<label class="dictionary-builtin-option"><input id="builtin-dictionary" type="checkbox"${project.settings?.builtinDictionary ? " checked" : ""}>启用内置常用参数</label>`}</div><div class="dictionary-table-wrap"${rows ? "" : " hidden"}><table class="dictionary-table" aria-label="${label}参数"><thead><tr><th scope="col">参数名称</th><th scope="col">参数描述</th>${isCustom ? '<th scope="col">默认值 / 示例</th><th scope="col">操作</th>' : ""}</tr></thead><tbody>${rows}</tbody></table></div><div class="dictionary-empty" role="status"${rows ? " hidden" : ""}>${emptyIcon}<span data-dictionary-empty-text>暂无数据</span></div>${isCustom && temporary.length ? `<section class="dictionary-temporary"><h2>临时捕获 · 刷新后消失</h2>${temporary.map((entry, index) => `<div class="row"><span class="grow">${esc(entry.key)} · ${esc(entry.description)}</span><button type="button" data-save-temporary-parameter="${index}">保存至字典</button></div>`).join("")}</section>` : ""}</section>`;
  };
  return `<section class="dictionary-surface" aria-labelledby="dictionary-surface-heading"><header class="dictionary-title-strip"><h1 id="dictionary-surface-heading" tabindex="-1">${dictionaryIcon}数据字典</h1><button type="button" class="ghost dictionary-model-shortcut" data-dictionary-jump="dictionary-models-heading">数据模型</button></header><div class="dictionary-content"><div class="dictionary-tabs" role="tablist" aria-label="数据字典">${dictionaryTabs.map(([key, label], index) => `<button type="button" id="dictionary-tab-${key}" data-dictionary-tab="${key}" role="tab" aria-selected="${!index}" aria-controls="dictionary-panel-${key}" tabindex="${index ? -1 : 0}">${label}</button>`).join("")}</div>${dictionaryTabs.map(([key, label]) => panel(key, label)).join("")}</div></section>`;
}

export function dictionaryEntryEditor(entry) {
  const extras = Object.fromEntries(
    ["default", "example", "enum"]
      .filter((key) => entry[key] !== undefined)
      .map((key) => [key, entry[key]]),
  );
  const types = ["string", "integer", "number", "boolean", "object", "array"];
  return `<div class="dictionary-entry-editor"><div class="dictionary-entry-core"><div><label for="dict-key">参数名称</label><input id="dict-key" value="${esc(entry.key)}"></div><div><label for="dict-note">备注名</label><input id="dict-note" value="${esc(entry.note)}"></div></div><select id="dict-type" aria-label="参数类型">${types.map((type) => `<option value="${type}"${type === entry.type ? " selected" : ""}>${type}</option>`).join("")}</select><div class="dictionary-entry-extras"><label for="modal-json">默认值 / 示例 / 枚举（JSON 对象）</label><textarea id="modal-json" rows="4" spellcheck="false">${esc(JSON.stringify(extras, null, 2))}</textarea></div><div><label for="dict-description">字段描述</label><textarea id="dict-description" rows="2">
${esc(entry.description)}</textarea></div></div>`;
}

export function matchesDictionarySearch(entry, query) {
  const text = query.trim().toLowerCase();
  return [entry.key, entry.description].some((value) =>
    (value ?? "").toLowerCase().includes(text),
  );
}

export function dictionaryViewPosition(page, projectId) {
  if (page?.dataset.dictionaryProject !== projectId) return;
  return {
    scrollTop: page.scrollTop,
    section: page
      .closest(".shell")
      .querySelector(".dictionary-side-nav [aria-current]")?.dataset
      .dictionaryJump,
    tab: page.querySelector('[role="tab"][aria-selected="true"]')?.dataset
      .dictionaryTab,
    queries: Object.fromEntries(
      [...page.querySelectorAll("[data-dictionary-panel]")].map((panel) => [
        panel.dataset.dictionaryPanel,
        panel.querySelector("[data-dictionary-search]").value,
      ]),
    ),
  };
}

export function bindDictionaryView(page, position) {
  const links = [
    ...page.closest(".shell").querySelectorAll("[data-dictionary-jump]"),
  ];
  const markSection = (id) => {
    for (const link of links) {
      if (link.dataset.dictionaryJump === id)
        link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };
  for (const link of links)
    link.addEventListener("click", () => {
      const id = link.dataset.dictionaryJump;
      const heading = page.querySelector("#" + id);
      if (!heading) return;
      markSection(id);
      heading.scrollIntoView({ block: "start", inline: "nearest" });
      heading.focus({ preventScroll: true });
    });
  markSection(position?.section ?? "dictionary-surface-heading");
  page.scrollTop = position?.scrollTop ?? 0;

  const tabs = [...page.querySelectorAll("[data-dictionary-tab]")];
  const panels = [...page.querySelectorAll("[data-dictionary-panel]")];
  const select = (key) => {
    for (const tab of tabs) {
      const selected = tab.dataset.dictionaryTab === key;
      tab.setAttribute("aria-selected", selected);
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels)
      panel.hidden = panel.dataset.dictionaryPanel !== key;
  };
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(tab.dataset.dictionaryTab));
    tab.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return;
      const target = {
        Home: 0,
        End: tabs.length - 1,
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        ArrowRight: (index + 1) % tabs.length,
      }[event.key];
      if (!Number.isInteger(target)) return;
      event.preventDefault();
      select(tabs[target].dataset.dictionaryTab);
      tabs[target].focus();
    });
  }
  select(position?.tab === "builtin" ? "builtin" : "custom");
  for (const panel of panels) {
    const search = panel.querySelector("[data-dictionary-search]");
    const rows = [...panel.querySelectorAll("[data-dictionary-row]")].map(
      (row) => {
        const [key, description] = row.querySelectorAll(
          "[data-dictionary-match]",
        );
        return {
          row,
          key: key.textContent,
          description: description.textContent,
        };
      },
    );
    const wrapper = panel.querySelector(".dictionary-table-wrap");
    const empty = panel.querySelector(".dictionary-empty");
    const message = empty.querySelector("[data-dictionary-empty-text]");
    const filter = () => {
      let count = 0;
      for (const { row, key, description } of rows) {
        row.hidden = !matchesDictionarySearch(
          { key, description },
          search.value,
        );
        if (!row.hidden) count++;
      }
      wrapper.hidden = count === 0;
      empty.hidden = count > 0;
      message.textContent = search.value.trim() ? "未找到匹配参数" : "暂无数据";
    };
    search.value = position?.queries[panel.dataset.dictionaryPanel] ?? "";
    search.addEventListener("input", filter);
    filter();
  }
}

export const builtinParameters = [
  {
    id: "builtin-id",
    key: "id",
    type: "integer",
    description: "唯一标识",
    example: 1,
    note: "内置",
  },
  {
    id: "builtin-name",
    key: "name",
    type: "string",
    description: "名称",
    example: "示例",
    note: "内置",
  },
  {
    id: "builtin-email",
    key: "email",
    type: "string",
    description: "电子邮箱",
    example: "user@example.com",
    note: "内置",
  },
  {
    id: "builtin-page",
    key: "page",
    type: "integer",
    description: "页码",
    default: 1,
    note: "内置",
  },
  {
    id: "builtin-pageSize",
    key: "pageSize",
    type: "integer",
    description: "每页条数",
    default: 20,
    note: "内置",
  },
];
export function effectiveParameterDictionary(project) {
  const custom = project.parameterDictionary || [];
  return [
    ...custom,
    ...(project.settings?.builtinDictionary
      ? builtinParameters.filter(
          (entry) =>
            !custom.some(
              (item) => item.key === entry.key && item.type === entry.type,
            ),
        )
      : []),
  ];
}

// Refuse ambiguous edits: only insert a new own property in a JSON object.
export function insertDictionaryField(body, entry) {
  let object;
  try {
    object = JSON.parse(body.trim() || "{}");
  } catch {
    throw Error("请先修正请求体 JSON，再插入字典字段");
  }
  if (!object || typeof object !== "object" || Array.isArray(object))
    throw Error("字典字段只能插入 JSON 对象");
  if (Object.hasOwn(object, entry.key))
    throw Error("请求体已有同名字段，未覆盖现有值");
  const value = dictionaryValue(entry);
  Object.defineProperty(object, entry.key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return JSON.stringify(object, null, 2);
}

export function dictionaryValue(entry) {
  if (entry.default !== undefined) return entry.default;
  if (entry.example !== undefined) return entry.example;
  if (entry.enum?.length) return entry.enum[0];
  return (
    {
      string: "",
      integer: 0,
      number: 0,
      boolean: false,
      object: {},
      array: [],
    }[entry.type] ?? null
  );
}
