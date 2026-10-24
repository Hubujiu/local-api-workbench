import { variableMapsFromRows } from "./variable-definitions.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function mountVariableEditor(container, rows) {
  const draft = rows.map((row) => ({
    key: row.key,
    initial: JSON.stringify(row.initialValue),
    current: row.currentSet ? JSON.stringify(row.currentValue) : '""',
    currentSet: row.currentSet,
    description: row.description,
    initialExplicit: row.initialExplicit,
  }));
  let page = 0;
  const pageSize = 50;
  const collect = () => {
    for (const element of container.querySelectorAll("[data-variable-index]")) {
      const row = draft[Number(element.dataset.variableIndex)];
      for (const field of ["key", "initial", "current", "description"])
        row[field] = element.querySelector(
          `[data-variable-field="${field}"]`,
        ).value;
      row.currentSet = element.querySelector(
        '[data-variable-field="currentSet"]',
      ).checked;
    }
  };
  const render = () => {
    page = Math.max(0, Math.min(page, Math.ceil(draft.length / pageSize) - 1));
    container.innerHTML = `<p class="muted">值使用 JSON 格式，字符串需要双引号。确认后初始值独立保存；脚本只更新当前值。取消“设置当前值”不会回退初始值。移除行将在确认后删除整个变量。所有值仍保存在本地明文项目中。</p><div class="table-scroll"><table class="variable-table"><thead><tr><th>变量名</th><th>初始值</th><th>当前值</th><th>说明 / 操作</th></tr></thead><tbody>${draft
      .slice(page * pageSize, (page + 1) * pageSize)
      .map(
        (row, index) =>
          `<tr data-variable-index="${page * pageSize + index}"><td><input data-variable-field="key" aria-label="变量名" maxlength="200" value="${esc(row.key)}">${row.initialExplicit ? "" : "<small>旧单值；确认后固定初始值</small>"}</td><td><textarea data-variable-field="initial" aria-label="初始值 JSON" spellcheck="false">${esc(row.initial)}</textarea></td><td><label><input type="checkbox" data-variable-field="currentSet" ${row.currentSet ? "checked" : ""}>设置当前值</label><textarea data-variable-field="current" aria-label="当前值 JSON" spellcheck="false" ${row.currentSet ? "" : "disabled"}>${esc(row.current)}</textarea></td><td><textarea data-variable-field="description" aria-label="变量说明" maxlength="4000">${esc(row.description)}</textarea><button type="button" data-variable-reset>恢复初始值</button><button type="button" data-variable-remove class="danger">移除</button></td></tr>`,
      )
      .join(
        "",
      )}</tbody></table></div><div class="row"><button type="button" id="variable-add">＋ 新增变量</button><span class="grow">${draft.length} 项 · 第 ${page + 1} / ${Math.max(1, Math.ceil(draft.length / pageSize))} 页</span><button type="button" data-variable-page="-1" ${page === 0 ? "disabled" : ""}>上一页</button><button type="button" data-variable-page="1" ${(page + 1) * pageSize >= draft.length ? "disabled" : ""}>下一页</button></div><p id="variable-editor-error" role="alert"></p>`;
    for (const element of container.querySelectorAll("[data-variable-index]")) {
      const index = Number(element.dataset.variableIndex);
      element.querySelector("[data-variable-remove]").onclick = () => {
        collect();
        draft.splice(index, 1);
        render();
      };
      element.querySelector("[data-variable-reset]").onclick = () => {
        element.querySelector('[data-variable-field="current"]').value =
          element.querySelector('[data-variable-field="initial"]').value;
        element.querySelector('[data-variable-field="currentSet"]').checked =
          true;
        element.querySelector('[data-variable-field="current"]').disabled =
          false;
      };
      element.querySelector('[data-variable-field="currentSet"]').onchange = (
        event,
      ) => {
        element.querySelector('[data-variable-field="current"]').disabled =
          !event.target.checked;
      };
    }
    for (const button of container.querySelectorAll("[data-variable-page]"))
      button.onclick = () => {
        collect();
        page += Number(button.dataset.variablePage);
        render();
      };
    container.querySelector("#variable-add").onclick = () => {
      collect();
      if (draft.length >= 10000) {
        container.querySelector("#variable-editor-error").textContent =
          "变量数量超过限制";
        return;
      }
      draft.push({
        key: "",
        initial: '""',
        current: '""',
        currentSet: true,
        description: "",
        initialExplicit: true,
      });
      page = Math.floor((draft.length - 1) / pageSize);
      render();
      container
        .querySelector(
          `[data-variable-index="${draft.length - 1}"] [data-variable-field="key"]`,
        )
        .focus();
    };
  };
  render();
  return {
    read() {
      collect();
      const parse = (text, index, label) => {
        try {
          return JSON.parse(text);
        } catch {
          throw Error(`第${index + 1}行${label}不是有效JSON`);
        }
      };
      return variableMapsFromRows(
        draft.map((row, index) => ({
          key: row.key,
          initialValue: parse(row.initial, index, "初始值"),
          currentSet: row.currentSet,
          currentValue: row.currentSet
            ? parse(row.current, index, "当前值")
            : undefined,
          description: row.description,
        })),
      );
    },
  };
}
