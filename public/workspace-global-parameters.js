import {
  globalParameterKinds,
  validateGlobalParameters,
} from "./global-parameters.js";

const tabs = [
  ["headers", "Header"],
  ["form", "Body"],
  ["query", "Query"],
  ["cookies", "Cookie"],
];

export function globalParameterWorkspaceIssue(settings = {}) {
  if (settings?.nativeInheritance !== undefined)
    return "此项目保留了原生继承图，不能混入项目公共参数。此处不会修改原生参数。";
  try {
    validateGlobalParameters(settings?.globalParameters);
  } catch {
    return "现有参数不符合此编辑器支持的结构。为保留原始参数及其元数据，此处不覆盖它们。";
  }
  return "";
}

export function createGlobalParameterDraft(source) {
  validateGlobalParameters(source);
  return Object.fromEntries(
    globalParameterKinds.map((kind) => [
      kind,
      (source?.[kind] ?? []).map((row) => ({
        key: row.key,
        valueText: JSON.stringify(row.value),
        enabled: row.enabled,
      })),
    ]),
  );
}

export function readGlobalParameterDraft(source, draft) {
  const next = { ...(source || {}) };
  for (const kind of globalParameterKinds) {
    const previous = source?.[kind] ?? [];
    const label = tabs.find(([key]) => key === kind)[1];
    const rows = draft[kind].map((row, i) => {
      let value;
      try {
        value = JSON.parse(row.valueText);
      } catch {
        throw Error(`${label} 第 ${i + 1} 行的参数值不是有效 JSON 字符串`);
      }
      if (typeof value !== "string")
        throw Error(`${label} 第 ${i + 1} 行的参数值必须是文本`);
      return {
        key: row.key,
        value,
        ...(row.enabled === undefined ? {} : { enabled: row.enabled }),
      };
    });
    if (
      previous.length !== rows.length ||
      previous.some(
        (row, i) =>
          row.key !== rows[i].key ||
          row.value !== rows[i].value ||
          row.enabled !== rows[i].enabled,
      )
    )
      next[kind] = rows;
  }
  validateGlobalParameters(next);
  return next;
}

export function workspaceGlobalParametersHTML(issue) {
  if (issue)
    return `<section class="environment-dialog-main environment-parameter-content" aria-label="项目全局参数"><p class="notice">${issue}</p></section>`;
  return `<section class="environment-dialog-main environment-parameter-content" aria-label="项目全局参数">
    <p class="environment-dialog-notice">仅用于本项目中继承公共参数的 HTTP 接口；目录、接口同名值优先，原有快照不变。请勿填入跨站点通用密钥。支持 {{变量}}；这里保存的是草稿。</p>
    <div class="environment-parameter-tabs" role="tablist" aria-label="全局参数类别">${tabs.map(([key, label]) => `<button type="button" id="environment-parameter-tab-${key}" role="tab" data-workspace-parameter-tab="${key}" aria-controls="environment-parameter-panel">${label}</button>`).join("")}</div>
    <section id="environment-parameter-panel" role="tabpanel">
      <div class="environment-parameter-scope"><span id="environment-parameter-scope">项目范围</span><button id="environment-parameter-advanced" type="button" class="ghost">目录、共享认证与脚本（设置）</button></div>
      <div class="environment-table-wrap"><table class="environment-parameter-table"><thead><tr><th scope="col"><input type="checkbox" id="environment-parameter-all" aria-label="启用本类别所有参数"></th><th scope="col">参数名</th><th scope="col">参数值</th><th scope="col">操作</th></tr></thead><tbody id="environment-parameter-rows"></tbody></table></div>
      <button type="button" class="environment-add-variable" id="environment-parameter-add">＋ 添加参数</button>
      <p id="environment-parameter-error" role="alert"></p>
    </section>
  </section>`;
}
function rowHTML(index, editing) {
  return `<tr data-workspace-parameter-row="${index}"><td><input type="checkbox" data-workspace-parameter-enabled aria-label="启用参数"></td><td><input data-workspace-parameter-key aria-label="参数名" maxlength="200" autocomplete="off"></td><td><span data-workspace-parameter-status></span><button type="button" data-workspace-parameter-edit aria-expanded="${editing}" aria-controls="environment-parameter-value-${index}">${editing ? "隐藏值" : "编辑值"}</button></td><td><button type="button" class="ghost" data-workspace-parameter-remove aria-label="删除参数">×</button></td></tr>${
    editing
      ? `<tr id="environment-parameter-value-${index}"><td colspan="4"><label for="environment-parameter-value-input">参数值（JSON 字符串，使用双引号）</label><textarea id="environment-parameter-value-input" rows="3" spellcheck="false" autocomplete="off"></textarea></td></tr>`
      : `<tr id="environment-parameter-value-${index}" hidden><td colspan="4"></td></tr>`
  }`;
}

export function mountWorkspaceGlobalParameters(
  container,
  source,
  initialTab = "headers",
) {
  const draft = createGlobalParameterDraft(source);
  const body = container.querySelector("#environment-parameter-rows");
  const panel = container.querySelector("#environment-parameter-panel");
  const scope = container.querySelector("#environment-parameter-scope");
  const add = container.querySelector("#environment-parameter-add");
  const selectAll = container.querySelector("#environment-parameter-all");
  const notice = container.querySelector("#environment-parameter-error");
  const buttons = [
    ...container.querySelectorAll("[data-workspace-parameter-tab]"),
  ];
  let kind = Object.hasOwn(draft, initialTab) ? initialTab : "headers";
  let activeValue = null;
  let changed = false;
  const rows = () => draft[kind];
  const focusTab = () =>
    buttons
      .find((button) => button.dataset.workspaceParameterTab === kind)
      ?.focus();
  const touch = () => {
    changed = true;
    notice.textContent = "";
  };
  const refreshToggle = () => {
    const enabledCount = rows().filter((row) => row.enabled !== false).length;
    selectAll.disabled = !rows().length;
    selectAll.checked = enabledCount > 0 && enabledCount === rows().length;
    selectAll.indeterminate = enabledCount > 0 && enabledCount < rows().length;
  };
  const draw = () => {
    for (const button of buttons) {
      const active = button.dataset.workspaceParameterTab === kind;
      button.tabIndex = active ? 0 : -1;
      button.setAttribute("aria-selected", String(active));
      if (active) panel.setAttribute("aria-labelledby", button.id);
    }
    scope.textContent =
      kind === "form"
        ? "项目范围 · 仅表单文本（form-data / urlencoded）"
        : "项目范围";
    body.innerHTML =
      rows()
        .map((row, index) => rowHTML(index, row === activeValue))
        .join("") ||
      '<tr class="environment-empty-row"><td colspan="4">暂无项目全局参数</td></tr>';
    refreshToggle();
    for (const tr of body.querySelectorAll("[data-workspace-parameter-row]")) {
      const index = Number(tr.dataset.workspaceParameterRow),
        row = rows()[index];
      const key = tr.querySelector("[data-workspace-parameter-key]");
      const enabled = tr.querySelector("[data-workspace-parameter-enabled]");
      const status = tr.querySelector("[data-workspace-parameter-status]");
      const edit = tr.querySelector("[data-workspace-parameter-edit]");
      const updateStatus = () => {
        status.textContent = row.valueText === '""' ? "空值" : "值已隐藏";
      };
      key.value = row.key;
      key.oninput = () => {
        row.key = key.value;
        touch();
      };
      enabled.checked = row.enabled !== false;
      enabled.onchange = () => {
        row.enabled = enabled.checked;
        touch();
        refreshToggle();
      };
      updateStatus();
      edit.onclick = () => {
        activeValue = activeValue === row ? null : row;
        draw();
        (activeValue
          ? container.querySelector("#environment-parameter-value-input")
          : body.querySelector(
              `[data-workspace-parameter-row="${index}"] [data-workspace-parameter-edit]`,
            )
        ).focus();
      };
      if (row === activeValue) {
        const value = container.querySelector(
          "#environment-parameter-value-input",
        );
        value.value = row.valueText;
        value.oninput = () => {
          row.valueText = value.value;
          updateStatus();
          touch();
        };
        value.onkeydown = (event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          edit.click();
        };
      }
      tr.querySelector("[data-workspace-parameter-remove]").onclick = () => {
        if (activeValue === row) activeValue = null;
        rows().splice(index, 1);
        touch();
        draw();
        add.focus();
      };
    }
  };
  function select(button) {
    kind = button.dataset.workspaceParameterTab;
    activeValue = null;
    draw();
    focusTab();
  }
  for (const [i, button] of buttons.entries()) {
    button.onclick = () => select(button);
    button.onkeydown = (event) => {
      const next = {
        Home: 0,
        End: buttons.length - 1,
        ArrowLeft: (i + buttons.length - 1) % buttons.length,
        ArrowRight: (i + 1) % buttons.length,
      }[event.key];
      if (!Number.isInteger(next)) return;
      event.preventDefault();
      select(buttons[next]);
    };
  }
  selectAll.onchange = () => {
    for (const row of rows())
      if ((row.enabled !== false) !== selectAll.checked)
        row.enabled = selectAll.checked;
    activeValue = null;
    touch();
    draw();
  };
  add.onclick = () => {
    if (rows().length >= 100) {
      notice.textContent = "每类全局参数最多 100 条";
      return;
    }
    rows().push({ key: "", valueText: '""', enabled: true });
    activeValue = null;
    touch();
    draw();
    body
      .querySelector(
        `[data-workspace-parameter-row="${rows().length - 1}"] [data-workspace-parameter-key]`,
      )
      ?.focus();
  };
  draw();
  return {
    focusTab,
    get changed() {
      return changed;
    },
    get kind() {
      return kind;
    },
    read: () => readGlobalParameterDraft(source, draft),
  };
}
