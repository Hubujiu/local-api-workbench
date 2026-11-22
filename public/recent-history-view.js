import { icon } from "./icons.js";
import { validateSavedVersionSummary } from "./recent-saved-versions.js";

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

const timeline = (groups, row) =>
  groups
    .map(
      (group) =>
        `<details class="recent-history-day" open><summary>${esc(group.label)}</summary><ol>${group.rows.map(row).join("")}</ol></details>`,
    )
    .join("");

function savedRow({ record, time }, selectable) {
  return `<li class="recent-history-row" data-recent-history-row><div class="recent-history-item">${selectable ? `<input type="checkbox" class="recent-saved-checkbox" data-recent-saved-select="${esc(record.requestId)}" aria-label="选择 ${esc(record.name || "未命名接口")}">` : ""}<span class="recent-history-icon" aria-hidden="true">${icon("▤")}</span><span class="method ${/^[A-Z]+$/.test(record.method) ? record.method : ""}">${esc(record.method)}</span><strong data-recent-history-name>${esc(record.name || "未命名接口")}</strong></div><div class="recent-history-meta"><time datetime="${esc(time.iso)}">${esc(time.label)}</time></div><span class="recent-version-number">${record.version === 1 ? "起始版本（首次记录）" : "已记录版本 " + record.version}</span></li>`;
}

export function recentHistoryPage(
  history = [],
  { disabled = false, protocol = "", now = new Date() } = {},
) {
  return `<div class="page recent-workspace"><section class="recent-http-history" aria-label="最近"><div class="recent-history-toolbar"><div class="recent-history-tabs" role="tablist" aria-label="最近活动"><button id="recent-sent-tab" type="button" role="tab" aria-controls="recent-sent-panel" aria-selected="true">历史发送记录</button><button id="recent-saved-tab" type="button" role="tab" aria-controls="recent-saved-panel" aria-selected="false" tabindex="-1">已保存版本</button></div><button id="history-project-reload" type="button" ${disabled ? "disabled" : ""}>重新加载项目记录（不重发）</button><span class="recent-history-count muted" id="recent-history-count" role="status">匹配 ${history.length} / ${history.length} 条记录</span><label class="recent-history-search"><span aria-hidden="true">⌕</span><input id="recent-history-query" type="search" aria-label="按发送记录名称筛选" placeholder="请输入名称" maxlength="200" autocomplete="off"></label></div><div id="recent-sent-panel" role="tabpanel" aria-labelledby="recent-sent-tab"><div class="recent-history-timeline">${timeline(groupRecentHistory(history, now), renderRow)}<p class="recent-history-empty muted"${history.length ? " hidden" : ""}>暂无请求历史</p></div></div><div id="recent-saved-panel" role="tabpanel" aria-labelledby="recent-saved-tab" hidden><div id="recent-saved-info"><p class="recent-saved-explanation muted">仅显示已保存且有版本记录的活动接口。首次记录可能来自旧项目建立追踪；版本时间不代表某个人的编辑时间。</p><p id="recent-saved-status" class="muted" role="status"></p><button id="recent-saved-reload" type="button" hidden>重新读取已保存版本</button></div><div id="recent-saved-selection" class="recent-saved-selection" hidden><span role="status" id="recent-saved-selection-count"></span><button type="button" id="recent-saved-trash">批量删除</button><button type="button" id="recent-saved-selection-cancel">取消</button></div><div id="recent-saved-list"></div></div></section><div class="recent-protocol-history">${protocol}</div></div>`;
}

export function bindRecentHistoryFilter(
  root,
  { projectId, active, loadSaved, canSelectSaved, confirmMoveSaved } = {},
) {
  const search = root?.querySelector("#recent-history-query");
  if (!search) return;
  const sent = root.querySelector("#recent-sent-panel");
  const saved = root.querySelector("#recent-saved-panel");
  const summary = root.querySelector("#recent-saved-status");
  const list = root.querySelector("#recent-saved-list");
  const info = root.querySelector("#recent-saved-info");
  const batch = root.querySelector("#recent-saved-selection");
  const move = root.querySelector("#recent-saved-trash");
  const cancel = root.querySelector("#recent-saved-selection-cancel");
  const selectionCount = root.querySelector("#recent-saved-selection-count");
  const checks = () => [...list.querySelectorAll("[data-recent-saved-select]")];
  const selectedChecks = () =>
    checks().filter(
      (input) =>
        input.checked &&
        !input.disabled &&
        !input.closest("[data-recent-history-row]").hidden &&
        !input.closest(".recent-history-day").hidden &&
        input.closest(".recent-history-day").open,
    );
  let receipt,
    selectionVersion = 0,
    moved = false;
  const selectedIds = () =>
    selectedChecks().map((input) => input.dataset.recentSavedSelect);
  const updateSelection = () => {
    selectionVersion++;
    const chosen = new Set(selectedChecks());
    for (const input of checks()) {
      if (!chosen.has(input)) input.checked = false;
      input
        .closest("[data-recent-history-row]")
        .classList.toggle("recent-saved-selected", chosen.has(input));
    }
    batch.hidden = !chosen.size;
    selectionCount.textContent = `已选择 ${chosen.size} 项`;
    saved.classList.toggle("recent-saved-selecting", Boolean(chosen.size));
  };
  const clearSelection = () => {
    for (const input of checks()) input.checked = false;
    updateSelection();
  };
  cancel.addEventListener("click", () => {
    const first = selectedChecks()[0];
    clearSelection();
    first?.focus({ preventScroll: true });
  });
  list.addEventListener("change", (event) => {
    if (!event.target.matches("[data-recent-saved-select]")) return;
    if (!canSelectSaved?.(receipt)) event.target.checked = false;
    updateSelection();
  });
  list.addEventListener(
    "toggle",
    () => {
      if (
        selectedChecks().length !==
        checks().filter((input) => input.checked).length
      )
        updateSelection();
    },
    true,
  );
  move.addEventListener("click", () => {
    const ids = selectedIds();
    const previous = receipt;
    const version = selectionVersion;
    const current = () => {
      if (
        !root.isConnected ||
        !active() ||
        !ready ||
        selected !== 1 ||
        receipt !== previous ||
        selectionVersion !== version ||
        !canSelectSaved?.(previous)
      )
        return false;
      const latestIds = selectedIds();
      return (
        ids.length === latestIds.length &&
        ids.every((id, index) => id === latestIds[index])
      );
    };
    if (!ids.length || !current()) return;
    confirmMoveSaved({
      ids,
      receipt: previous,
      current,
      opener: move,
      applied: () => {
        moved = true;
        clearSelection();
        list.querySelectorAll("[data-recent-saved-select]").forEach((input) => {
          input.disabled = true;
        });
        summary.textContent =
          "所选接口已在项目草稿中移到回收站；点击「保存项目」才会写入。";
      },
    });
  });
  const reload = root.querySelector("#recent-saved-reload");
  const reloadHistory = root.querySelector("#history-project-reload");
  const counter = root.querySelector("#recent-history-count");
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const drafts = ["", ""];
  const priorDisclosure = new WeakMap();
  let selected = 0,
    generation = 0,
    ready = false;
  const filter = () => {
    if (selected && !ready) return;
    const panel = selected ? saved : sent;
    const filtering = Boolean(search.value.trim());
    let count = 0,
      total = 0;
    for (const group of panel.querySelectorAll(".recent-history-day")) {
      let matched = false;
      for (const row of group.querySelectorAll("[data-recent-history-row]")) {
        total++;
        row.hidden = !matchesRecentHistoryName(
          row.querySelector("[data-recent-history-name]").textContent,
          search.value,
        );
        if (!row.hidden) {
          matched = true;
          count++;
        }
      }
      group.hidden = !matched;
      if (filtering) {
        if (!priorDisclosure.has(group)) priorDisclosure.set(group, group.open);
        if (matched) group.open = true;
      } else if (priorDisclosure.has(group)) {
        group.open = priorDisclosure.get(group);
        priorDisclosure.delete(group);
      }
    }
    counter.textContent = `匹配 ${count} / ${total} 条记录`;
    const empty = panel.querySelector(".recent-history-empty");
    empty.hidden = count !== 0;
    empty.textContent = filtering
      ? selected
        ? "暂无符合名称的已保存版本"
        : "暂无符合名称的发送记录"
      : selected
        ? "暂无已记录版本"
        : "暂无请求历史";
  };
  const refresh = async () => {
    const ticket = ++generation;
    const current = () =>
      root.isConnected && active() && selected === 1 && generation === ticket;
    ready = false;
    clearSelection();
    receipt = undefined;
    // Keep the pending draft notice even when the persisted metadata is reread.
    list.before(info);
    list.replaceChildren();
    summary.textContent = "正在读取已保存版本…";
    counter.hidden = true;
    reload.hidden = true;
    try {
      const response = await loadSaved(projectId);
      if (!current()) return;
      const data = (receipt = validateSavedVersionSummary(response, projectId));
      const selectable = Boolean(canSelectSaved?.(data));
      const rows = data.rows.map((row) => ({
        ...row,
        createdAt: row.currentCreatedAt,
      }));
      list.innerHTML =
        timeline(groupRecentHistory(rows), (row) => savedRow(row, selectable)) +
        '<p class="recent-history-empty muted" hidden></p>';
      if (rows.length) list.after(info);
      summary.textContent = `已记录 ${data.tracked} 个接口${data.tracked > data.rows.length ? `，显示最近 ${data.rows.length} 个` : ""}；另有 ${data.untracked} 个接口未建立版本记录。`;
      if (moved)
        summary.textContent +=
          " 所选接口已在项目草稿中移到回收站；点击「保存项目」才会写入。";
      counter.hidden = false;
      ready = true;
      filter();
    } catch {
      if (current()) summary.textContent = "未能读取当前项目的已保存版本。";
    } finally {
      if (current()) reload.hidden = false;
    }
  };
  const select = (index, focus = false) => {
    if (selected !== index) {
      if (selected) clearSelection();
      drafts[selected] = search.value;
      selected = index;
      generation++;
      search.value = drafts[index];
      search.setAttribute(
        "aria-label",
        index ? "按已保存接口名称筛选" : "按发送记录名称筛选",
      );
      for (const [position, tab] of tabs.entries()) {
        tab.tabIndex = position === index ? 0 : -1;
        tab.setAttribute("aria-selected", String(position === index));
      }
      sent.hidden = index === 1;
      saved.hidden = index === 0;
      reloadHistory.hidden = index === 1;
      if (index) void refresh();
      else {
        counter.hidden = false;
        filter();
      }
    }
    if (focus) tabs[index].focus();
  };
  search.addEventListener("input", () => {
    if (selected) clearSelection();
    filter();
  });
  reload.addEventListener("click", refresh);
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(index));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      select(
        event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index,
        true,
      );
    });
  }
}
