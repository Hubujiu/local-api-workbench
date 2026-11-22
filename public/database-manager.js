import { icon } from "./icons.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const engines = new Map([
  ["sqlite", "SQLite"],
  ["postgres", "PostgreSQL"],
  ["mysql", "MySQL"],
  ["clickhouse", "ClickHouse"],
  ["redis", "Redis"],
  ["mongodb", "MongoDB"],
  ["sqlserver", "SQL Server"],
  ["oracle", "Oracle"],
  ["dameng", "达梦 DM8"],
]);
export function databaseManagerHTML() {
  return `<div class="page dictionary-page database-manager" aria-labelledby="database-manager-heading">
    <header class="dictionary-title-strip"><h1 id="database-manager-heading" tabindex="-1">${icon("▥")}数据库管理</h1><button type="button" class="ghost" data-page="dictionary">返回字典</button></header>
    <div class="database-manager-content">
      <div class="database-manager-toolbar"><span>本项目临时会话授权</span><button type="button" class="ghost" id="db-manager-refresh">刷新列表</button><button type="button" class="primary" id="db-manager-configure" data-page="database">配置连接</button></div>
      <div class="database-manager-table" aria-busy="true"><table aria-label="本项目数据库会话授权">
        <colgroup><col><col><col><col></colgroup>
        <thead><tr><th scope="col">名称</th><th scope="col">数据库类型</th><th scope="col">授权范围</th><th scope="col">有效期</th></tr></thead>
        <tbody data-db-manager-rows></tbody>
      </table><p role="status" class="database-manager-status" data-db-manager-status>正在读取会话授权</p>
      <div class="database-manager-empty" aria-hidden="true" hidden>${icon("body-empty")}<span>暂无已授权连接</span></div></div>
    </div>
  </div>`;
}

export function databaseManagerRows(value) {
  if (!Array.isArray(value)) throw Error("会话列表无效");
  return value
    .map((item) => {
      if (
        !item ||
        typeof item.name !== "string" ||
        !item.name.trim() ||
        !engines.has(item.type) ||
        (item.expiresAt !== undefined &&
          (!Number.isFinite(item.expiresAt) ||
            item.expiresAt <= 0 ||
            !Number.isFinite(new Date(item.expiresAt).valueOf())))
      )
        throw Error("会话列表无效");
      const expiry =
        item.expiresAt === undefined
          ? "应用运行期间"
          : new Date(item.expiresAt).toLocaleString();
      return `<tr><td>${esc(item.name)}</td><td>${engines.get(item.type)}</td><td>本项目</td><td>${esc(expiry)}</td></tr>`;
    })
    .join("");
}

export function bindDatabaseManager(root, { list, owns }) {
  const table = root.querySelector(".database-manager-table");
  const body = root.querySelector("[data-db-manager-rows]");
  const state = root.querySelector("[data-db-manager-status]");
  const empty = root.querySelector(".database-manager-empty");
  let sequence = 0;
  const refresh = async () => {
    if (!root.isConnected || !owns()) return;
    const ticket = ++sequence;
    const isCurrent = () => root.isConnected && owns() && ticket === sequence;
    state.classList.remove("database-manager-status-settled");
    state.textContent = "正在读取会话授权";
    table.setAttribute("aria-busy", "true");
    body.replaceChildren();
    empty.hidden = true;
    try {
      const result = await list();
      if (!isCurrent()) return;
      body.innerHTML = databaseManagerRows(result);
      state.textContent = result.length
        ? "已读取 " + result.length + " 项会话授权"
        : "暂无已授权连接";
      state.classList.add("database-manager-status-settled");
      empty.hidden = result.length > 0;
    } catch {
      if (!isCurrent()) return;
      state.classList.remove("database-manager-status-settled");
      state.textContent = "无法读取会话授权，请重试。";
    } finally {
      if (isCurrent()) table.setAttribute("aria-busy", "false");
    }
  };
  root.querySelector("#db-manager-refresh").addEventListener("click", () => {
    void refresh();
  });
  void refresh();
}
