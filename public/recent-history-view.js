import { icon } from "./icons.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const pad = (value) => String(value).padStart(2, "0");
const localDay = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export function groupRecentHistory(history, now = new Date()) {
  const today = localDay(now);
  const grouped = new Map();
  const ordered = history
    .map((record, index) => ({
      record,
      index,
      time:
        typeof record.createdAt === "string"
          ? Date.parse(record.createdAt)
          : NaN,
    }))
    .sort((a, b) => {
      const first = Number.isFinite(a.time) ? a.time : -Infinity;
      const second = Number.isFinite(b.time) ? b.time : -Infinity;
      return first === second ? a.index - b.index : second - first;
    });
  for (const { record, time } of ordered) {
    const date = Number.isFinite(time) ? new Date(time) : null;
    const key = date ? localDay(date) : "unknown";
    if (!grouped.has(key))
      grouped.set(key, {
        label: key === today ? "今天" : date ? key : "未知日期",
        rows: [],
      });
    grouped.get(key).rows.push({
      record,
      time: date
        ? {
            iso: date.toISOString(),
            label: `${key} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
          }
        : null,
    });
  }
  return [...grouped.values()];
}

export function matchesRecentHistoryName(name, query) {
  return String(name ?? "")
    .toLocaleLowerCase()
    .includes(
      String(query ?? "")
        .trim()
        .toLocaleLowerCase(),
    );
}

function renderRow({ record, time }) {
  const method =
    typeof record.request?.method === "string" ? record.request.method : "";
  const status = record.response?.status;
  const hasStatus = Number.isInteger(status) && status >= 100 && status <= 599;
  return `<li class="recent-history-row" data-recent-history-row><div class="recent-history-item"><span class="recent-history-icon" aria-hidden="true">${icon("▤")}</span><span class="method ${/^[A-Z]+$/.test(method) ? method : ""}">${esc(method || "—")}</span><strong data-recent-history-name>${esc(record.name || "未命名请求")}</strong></div><div class="recent-history-meta">${time ? `<time datetime="${esc(time.iso)}">${esc(time.label)}</time>` : '<span class="muted">未记录时间</span>'}<span class="${hasStatus && status < 400 ? "success" : "failed"}">${hasStatus ? status : "ERROR"}</span></div><button type="button" data-history="${esc(record.id)}" ${record.id ? "" : "disabled"}>查看</button></li>`;
}

export function recentHistoryPage(
  history = [],
  { disabled = false, protocol = "", now = new Date() } = {},
) {
  const groups = groupRecentHistory(history, now);
  return `<div class="page recent-workspace"><section class="recent-http-history" aria-labelledby="recent-history-heading"><div class="recent-history-toolbar"><h1 id="recent-history-heading">历史发送记录</h1><button id="history-project-reload" type="button" ${disabled ? "disabled" : ""}>重新加载项目记录（不重发）</button><span class="recent-history-count muted" id="recent-history-count" role="status">匹配 ${history.length} / ${history.length} 条记录</span><label class="recent-history-search"><span aria-hidden="true">⌕</span><input id="recent-history-query" type="search" aria-label="按发送记录名称筛选" placeholder="请输入名称" maxlength="200" autocomplete="off"></label></div><div class="recent-history-timeline">${groups.map((group) => `<details class="recent-history-day" open><summary>${esc(group.label)}</summary><ol>${group.rows.map(renderRow).join("")}</ol></details>`).join("")}<p class="recent-history-empty muted"${history.length ? " hidden" : ""}>暂无请求历史</p></div></section><div class="recent-protocol-history">${protocol}</div></div>`;
}

export function bindRecentHistoryFilter(root) {
  const search = root?.querySelector("#recent-history-query");
  if (!search) return;
  const groups = [...root.querySelectorAll(".recent-history-day")].map(
    (group) => ({
      group,
      rows: [...group.querySelectorAll("[data-recent-history-row]")].map(
        (row) => ({
          row,
          name: row.querySelector("[data-recent-history-name]").textContent,
        }),
      ),
    }),
  );
  const total = groups.reduce((sum, { rows }) => sum + rows.length, 0);
  const counter = root.querySelector("#recent-history-count");
  const empty = root.querySelector(".recent-history-empty");
  search.addEventListener("input", () => {
    let count = 0;
    for (const { group, rows } of groups) {
      let matched = false;
      for (const { row, name } of rows) {
        row.hidden = !matchesRecentHistoryName(name, search.value);
        if (!row.hidden) {
          matched = true;
          count++;
        }
      }
      group.hidden = !matched;
    }
    counter.textContent = `匹配 ${count} / ${total} 条记录`;
    empty.hidden = count !== 0;
    empty.textContent = search.value.trim()
      ? "暂无符合名称的发送记录"
      : "暂无请求历史";
  });
}
