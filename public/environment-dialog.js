import { variableRows } from "./variable-definitions.js";
import { icon } from "./icons.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function readEnvironmentJSON(text) {
  const values = JSON.parse(text);
  variableRows(values);
  return values;
}
export function environmentDialogShell(
  project,
  { environment, section, workspace = false, content, actions = "" },
) {
  const current = environment?.id;
  const currentPage = (active) => (active ? 'aria-current="page"' : "");
  return `<div class="environment-dialog${workspace ? " environment-dialog--workspace" : ""}${section === "cookies" ? " environment-dialog--cookies" : ""}">
    <aside class="environment-dialog-nav" aria-label="环境设置导航">
      <p class="environment-section-label">全局</p>
      <button data-env-section="cookies" ${currentPage(section === "cookies")}><span class="environment-nav-icon cookie">${icon("◷")}</span>Cookie管理器</button>
      <button data-env-section="parameters"><span class="environment-nav-icon">${icon("☷")}</span>全局参数</button>
      <button data-env-section="globals"><span class="environment-nav-icon global">${icon("⇄")}</span>全局变量</button>
      <p class="environment-section-label">环境管理</p>
      <div class="environment-list">${project.environments.map((item) => `<button data-env-open="${esc(item.id)}" ${currentPage(section === "environment" && item.id === current)}><span class="environment-nav-icon">${icon("☷")}</span><span>${esc(item.name)}</span></button>`).join("")}
      ${section === "environment" && !environment ? '<button aria-current="page" data-env-current><span class="environment-nav-icon">' + icon("☷") + "</span><span>新建环境</span></button>" : ""}</div>
      <button class="environment-create" data-env-new>${workspace ? "＋ 新建环境" : "新建环境"}</button>
    </aside>
    ${content}
    ${actions}
  </div>`;
}

export function environmentDialogHTML(
  project,
  environment,
  { workspace = false } = {},
) {
  return environmentDialogShell(project, {
    environment,
    workspace,
    section: "environment",
    actions: '<button type="button" id="environment-save-stay">保存</button>',
    content: `
    <section class="environment-dialog-main">
      <p class="environment-dialog-notice">您可以在请求参数或者接口URL中引用环境变量，引用方法：{{ 变量名 }}</p>
      <label for="${environment ? "edit-env-name" : "env-name"}">环境名称</label>
      <input id="${environment ? "edit-env-name" : "env-name"}" value="${esc(environment?.name || "")}" placeholder="新建环境" autocomplete="off">
      <div class="environment-service-heading"><span>服务（前置URL）</span><button data-env-services>管理服务</button></div>
      <div class="environment-table-wrap"><table class="environment-service-table"><thead><tr><th>服务名</th><th>前置URL</th></tr></thead><tbody>${(project.servers || []).map((server) => `<tr><td>${esc(server.name)}</td><td>${esc(environment?.serverUrls?.[server.id] || "未配置")}</td></tr>`).join("") || '<tr><td colspan="2" class="environment-service-empty">暂无共享服务</td></tr>'}</tbody></table></div>
      <div class="environment-variable-heading"><label for="environment-variable-search">环境变量</label><input id="environment-variable-search" type="search" placeholder="搜索变量名、描述" aria-label="搜索环境变量"></div>
      <div class="environment-table-wrap"><table class="environment-value-table"><thead><tr><th>变量名</th><th>变量值 <small title="使用 JSON 格式保留字符串、数字和对象类型">JSON</small></th><th>描述</th></tr></thead><tbody id="environment-variable-rows"></tbody></table></div>
      <button type="button" class="environment-add-variable" id="environment-variable-add">添加变量</button>
      <details class="environment-json"><summary>高级 JSON 编辑</summary><p>仅编辑当前值，已有初始值和说明保持不变。字符串需使用双引号。所有值仍存于本地明文项目。</p><label for="modal-json">变量（JSON 对象）</label><textarea id="modal-json" spellcheck="false">${esc(JSON.stringify(environment?.variables || { baseUrl: "http://localhost:8080" }, null, 2))}</textarea></details>
      <p id="environment-dialog-error" role="alert"></p>
    </section>`,
  });
}
export function cookieManagerHTML(state, { workspace = false } = {}) {
  const warning =
    '<p class="notice">Cookie明文仅存当前电脑，按项目与环境隔离，Cookie库不进入项目备份，但请求/响应历史可能含Cookie，分享前请检查。开启后自动保存/发送匹配Cookie，并覆盖请求里手工填写的Cookie。此处操作立即生效，关闭窗口不撤销。</p><p id="cookie-error" class="failed" role="alert"></p>';
  const actions = `<button id="cookie-toggle">${state.enabled ? "关闭自动Cookie" : "开启自动Cookie"}</button><button id="cookie-refresh">重新加载</button><button id="cookie-clear">清空当前环境Cookie</button>`;
  const status = `<p>状态：${state.enabled ? "已开启" : "已关闭"} · ${state.cookies.length}/500</p>`;
  const table = `<div class="cookie-table"><table><thead><tr><th>名称</th><th>值</th><th>域 / 路径</th><th>属性</th><th></th></tr></thead><tbody>${state.cookies.map((c, i) => `<tr><td>${esc(c.key)}</td><td><input type="password" readonly value="${esc(c.value)}" aria-label="Cookie值"></td><td>${esc(c.domain)}<br>${esc(c.path)}</td><td>${c.secure ? "Secure " : ""}${c.httpOnly ? "HttpOnly " : ""}${c.hostOnly ? "HostOnly" : ""}</td><td><button data-cookie-edit="${i}">编辑</button><button data-cookie-remove="${i}">删除</button></td></tr>`).join("")}</tbody></table></div>`;
  const edit = `<label for="cookie-url">来源URL（HTTP/HTTPS）</label><input id="cookie-url" placeholder="https://api.example.test/"><label for="cookie-line">Set-Cookie（同域、同路径、同名会覆盖；更改身份会新增）</label>${workspace ? '<input id="cookie-line" type="password" autocomplete="off" placeholder="name=value; Path=/; Secure">' : '<textarea id="cookie-line" placeholder="name=value; Path=/; Secure"></textarea>'}<button id="cookie-set">保存Cookie</button>`;
  if (!workspace) return warning + actions + status + table + edit;
  return `${warning}<div class="environment-cookie-actions">${actions}</div>${status}<details id="environment-cookie-add"><summary>添加 Cookie</summary>${edit}</details>${state.cookies.length ? table : '<div class="environment-cookie-empty"><p>暂无 Cookie</p></div>'}`;
}

export function mountEnvironmentDialog(container, environment) {
  const json = container.querySelector("#modal-json");
  const body = container.querySelector("#environment-variable-rows");
  const search = container.querySelector("#environment-variable-search");
  const error = container.querySelector("#environment-dialog-error");
  let rows = [],
    source = "json",
    changed = false;
  const tableValues = () => {
    const values = Object.create(null);
    for (const row of rows) {
      if (Object.hasOwn(values, row.key)) throw Error("变量名重复: " + row.key);
      values[row.key] = JSON.parse(row.value);
    }
    return readEnvironmentJSON(JSON.stringify(values));
  };
  const update = () => {
    changed = true;
    source = "table";
    try {
      json.value = JSON.stringify(tableValues(), null, 2);
      error.textContent = "";
    } catch (e) {
      error.textContent = e.message;
    }
  };
  const filter = () => {
    const term = search.value.toLowerCase();
    for (const element of body.children) {
      const row = rows[Number(element.dataset.environmentRow)];
      element.hidden = !(
        row.key +
        " " +
        (environment?.variableDefinitions?.[row.key]?.description || "")
      )
        .toLowerCase()
        .includes(term);
    }
  };
  const render = () => {
    body.innerHTML =
      rows
        .map(
          (row, index) =>
            `<tr data-environment-row="${index}"><td><input data-env-key aria-label="变量名" value="${esc(row.key)}" maxlength="200"></td><td><input data-env-value aria-label="变量值 JSON" value="${esc(row.value)}" spellcheck="false"></td><td><span>${esc(environment?.variableDefinitions?.[row.key]?.description || "")}</span><button type="button" data-env-remove aria-label="移除当前值 ${esc(row.key)}">移除</button></td></tr>`,
        )
        .join("") ||
      '<tr class="environment-empty-row"><td colspan="3">暂无环境变量</td></tr>';
    for (const element of body.querySelectorAll("[data-environment-row]")) {
      const index = Number(element.dataset.environmentRow);
      element.querySelector("[data-env-key]").oninput = (event) => {
        rows[index].key = event.target.value;
        update();
      };
      element.querySelector("[data-env-value]").oninput = (event) => {
        rows[index].value = event.target.value;
        update();
      };
      element.querySelector("[data-env-remove]").onclick = () => {
        rows.splice(index, 1);
        update();
        render();
        container.querySelector("#environment-variable-add").focus();
      };
    }
    if (rows.length) filter();
  };
  const fromJSON = () => {
    const values = readEnvironmentJSON(json.value);
    rows = Object.entries(values).map(([key, value]) => ({
      key,
      value: JSON.stringify(value),
    }));
    render();
  };
  fromJSON();
  json.oninput = () => {
    changed = true;
    source = "json";
    try {
      fromJSON();
      error.textContent = "";
    } catch (e) {
      error.textContent = e.message;
    }
  };
  search.oninput = () => {
    if (rows.length) filter();
  };
  container.querySelector("#environment-variable-add").onclick = () => {
    if (source === "json") {
      try {
        fromJSON();
      } catch (e) {
        error.textContent = e.message;
        return;
      }
    }
    if (rows.length >= 10000) {
      error.textContent = "变量数量超过限制";
      return;
    }
    rows.push({ key: "", value: '""' });
    search.value = "";
    update();
    render();
    body.querySelector("tr:last-child input").focus();
  };
  const name = container.querySelector("#env-name, #edit-env-name");
  name.addEventListener("input", () => {
    changed = true;
  });
  return {
    get changed() {
      return changed;
    },
    read() {
      return source === "table"
        ? tableValues()
        : readEnvironmentJSON(json.value);
    },
  };
}
