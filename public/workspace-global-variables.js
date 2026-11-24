import { variableMapsFromRows } from "./variable-definitions.js";

export const workspaceGlobalVariablesHTML = () => `
  <section class="environment-dialog-main environment-global-content" aria-label="项目全局变量">
    <p class="environment-dialog-notice">同一项目下的所有环境均可引用全局变量：{{ 变量名 }}。同名值按项目全局、当前 Postman 集合（若有）、环境、调试运行时的顺序覆盖。这里只保存到项目草稿；点「保存项目」才会写入本地。</p>
    <input id="environment-global-search" type="search" autocomplete="off" placeholder="搜索变量名、描述" aria-label="搜索全局变量">
    <div class="environment-table-wrap"><table class="environment-global-table"><thead><tr><th scope="col">变量名</th><th scope="col">变量值 <small title="JSON 格式；字符串需要双引号">JSON</small></th><th scope="col">描述</th></tr></thead><tbody id="environment-global-rows"></tbody></table></div>
    <div class="environment-global-tools">
      <button type="button" class="environment-add-variable" id="environment-global-add">＋ 添加变量</button>
      <span id="environment-global-status" role="status"></span>
      <button type="button" data-global-page="-1" hidden>上一页</button>
      <button type="button" data-global-page="1" hidden>下一页</button>
    </div>
    <p id="environment-global-error" role="alert"></p>
  </section>`;

export function globalVariableDraftRows(rows) {
  return rows.map((row) => ({
    key: row.key,
    initial: JSON.stringify(row.initialValue),
    originalInitial: JSON.stringify(row.initialValue),
    current: row.currentSet ? JSON.stringify(row.currentValue) : '""',
    currentSet: row.currentSet,
    description: row.description,
    originalDescription: row.description,
    initialExplicit: row.initialExplicit,
  }));
}

export function readWorkspaceGlobalVariableRows(draft) {
  const parse = (str, index, label) => {
    try {
      return JSON.parse(str);
    } catch {
      throw Error(`第${index + 1}行${label}不是有效JSON`);
    }
  };
  const maps = variableMapsFromRows(
    draft.map((row, index) => ({
      key: row.key,
      initialValue: parse(row.initial, index, "初始值"),
      currentValue: row.currentSet
        ? parse(row.current, index, "当前值")
        : undefined,
      currentSet: row.currentSet,
      description: row.description,
    })),
  );
  for (const row of draft) {
    // Until the user explicitly edits metadata or unsets the current value,
    // keep legacy single-value entries single-valued.
    if (
      !row.initialExplicit &&
      row.currentSet &&
      row.initial === row.originalInitial &&
      row.description === row.originalDescription
    )
      delete maps.definitions[row.key];
  }
  return maps;
}

const rowHTML = (index, expanded) => `
  <tr data-global-row="${index}">
    <td><input data-global-field="key" aria-label="变量名" maxlength="200" autocomplete="off"></td>
    <td><div class="environment-global-value"><input data-global-field="current" aria-label="当前值 JSON" type="password" autocomplete="off" spellcheck="false" placeholder="未设置"><button type="button" data-global-reveal="current" aria-pressed="false">显示值</button></div></td>
    <td><textarea data-global-field="description" aria-label="变量描述" rows="1" maxlength="4000"></textarea><button type="button" class="ghost" data-global-details aria-expanded="${expanded}" aria-controls="environment-global-details-${index}">初始值 / 操作</button></td>
  </tr>
  <tr data-global-extra="${index}" id="environment-global-details-${index}" ${expanded ? "" : "hidden"}>
    <td colspan="3">
      <div class="environment-global-advanced">
        <label for="environment-global-initial-${index}">初始值 JSON</label>
        <div class="environment-global-value"><input id="environment-global-initial-${index}" data-global-field="initial" type="password" autocomplete="off" spellcheck="false"><button type="button" data-global-reveal="initial" aria-pressed="false">显示初始值</button></div>
        <label><input type="checkbox" data-global-current-set> 设置当前值</label>
        <p class="muted">取消设置当前值不会回退到初始值。恢复初始值需要明确操作。所有变量始终存于本地明文项目。</p>
        <button type="button" data-global-reset>恢复初始值</button>
        <button type="button" data-global-remove class="danger">移除变量</button>
      </div>
    </td>
  </tr>`;

export function mountWorkspaceGlobalVariables(container, rows, query = "") {
  const body = container.querySelector("#environment-global-rows");
  const search = container.querySelector("#environment-global-search");
  const add = container.querySelector("#environment-global-add");
  const status = container.querySelector("#environment-global-status");
  const error = container.querySelector("#environment-global-error");
  const pager = [...container.querySelectorAll("[data-global-page]")];
  const draft = globalVariableDraftRows(rows);
  const open = new Set();
  const perPage = 50;
  let page = 0;
  let changed = false;
  search.value = query;

  const matching = () => {
    const term = search.value.trim().toLowerCase();
    return draft.flatMap((row, index) =>
      (row.key + " " + row.description).toLowerCase().includes(term)
        ? [index]
        : [],
    );
  };
  const touch = () => {
    changed = true;
    error.textContent = "";
  };
  const draw = (indices = matching()) => {
    const totalPages = Math.max(1, Math.ceil(indices.length / perPage));
    page = Math.min(totalPages - 1, Math.max(page, 0));
    body.innerHTML =
      indices
        .slice(page * perPage, (page + 1) * perPage)
        .map((index) => rowHTML(index, open.has(draft[index])))
        .join("") ||
      `<tr class="environment-empty-row"><td colspan="3">${draft.length ? "未找到匹配的全局变量" : "暂无全局变量"}</td></tr>`;
    for (const [i, button] of pager.entries()) {
      button.hidden = totalPages < 2;
      button.disabled = i === 0 ? page === 0 : page === totalPages - 1;
    }
    status.textContent = indices.length
      ? indices.length +
        " 项" +
        (totalPages > 1 ? ` · 第 ${page + 1} / ${totalPages} 页` : "")
      : "";
    for (const tr of body.querySelectorAll("[data-global-row]")) {
      const index = Number(tr.dataset.globalRow),
        row = draft[index],
        extra = tr.nextElementSibling;
      const field = (key) =>
        (key === "initial" ? extra : tr).querySelector(
          `[data-global-field="${key}"]`,
        );
      const currentSet = extra.querySelector("[data-global-current-set]");
      const revealCurrent = tr.querySelector('[data-global-reveal="current"]');
      for (const key of ["key", "current", "description", "initial"]) {
        const input = field(key);
        input.value = row[key];
        input.oninput = () => {
          row[key] = input.value;
          touch();
        };
      }
      const showCurrentState = () => {
        field("current").disabled = !row.currentSet;
        currentSet.checked = row.currentSet;
        revealCurrent.disabled = !row.currentSet;
        if (!row.currentSet) {
          field("current").type = "password";
          revealCurrent.setAttribute("aria-pressed", "false");
          revealCurrent.textContent = "显示值";
          field("current").value = "";
        } else field("current").value = row.current;
      };
      showCurrentState();
      tr.querySelector("[data-global-details]").onclick = (event) => {
        if (extra.hidden) open.add(row);
        else open.delete(row);
        extra.hidden = !open.has(row);
        if (extra.hidden) {
          field("initial").type = "password";
          const reveal = extra.querySelector('[data-global-reveal="initial"]');
          reveal.setAttribute("aria-pressed", "false");
          reveal.textContent = "显示初始值";
        }
        event.currentTarget.setAttribute(
          "aria-expanded",
          String(!extra.hidden),
        );
      };
      for (const button of [
        revealCurrent,
        extra.querySelector('[data-global-reveal="initial"]'),
      ]) {
        button.onclick = () => {
          const initial = button.dataset.globalReveal === "initial";
          const input = field(button.dataset.globalReveal);
          const reveal = input.type === "password";
          input.type = reveal ? "text" : "password";
          button.setAttribute("aria-pressed", String(reveal));
          button.textContent =
            (reveal ? "隐藏" : "显示") + (initial ? "初始值" : "值");
        };
      }
      currentSet.onchange = () => {
        row.currentSet = currentSet.checked;
        showCurrentState();
        touch();
      };
      extra.querySelector("[data-global-reset]").onclick = () => {
        row.current = row.initial;
        row.currentSet = true;
        showCurrentState();
        touch();
      };
      extra.querySelector("[data-global-remove]").onclick = () => {
        draft.splice(index, 1);
        open.delete(row);
        touch();
        draw();
        add.focus();
      };
    }
  };
  search.oninput = () => {
    page = 0;
    draw();
  };
  for (const button of pager)
    button.onclick = () => {
      page += Number(button.dataset.globalPage);
      draw();
      (button.disabled ? search : button).focus();
    };
  add.onclick = () => {
    if (draft.length >= 10000) {
      error.textContent = "变量数量超过限制";
      return;
    }
    draft.push(
      ...globalVariableDraftRows([
        {
          key: "",
          initialValue: "",
          currentValue: "",
          description: "",
          currentSet: true,
          initialExplicit: true,
        },
      ]),
    );
    search.value = "";
    page = Math.floor((draft.length - 1) / perPage);
    touch();
    draw();
    body
      .querySelector(
        `[data-global-row="${draft.length - 1}"] [data-global-field="key"]`,
      )
      .focus();
  };
  draw();
  return {
    get changed() {
      return changed;
    },
    get query() {
      return search.value;
    },
    read: () => readWorkspaceGlobalVariableRows(draft),
  };
}
