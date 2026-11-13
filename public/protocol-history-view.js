const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const identity = (record) => record.id || record.runId || "";
const statusText = (record) => {
  const value = record.status ?? record.result?.status;
  return typeof value === "string" || typeof value === "number"
    ? value
    : value && typeof value.code === "number"
      ? `gRPC 状态码 ${value.code}`
      : typeof (record.state ?? record.result?.state) === "string"
        ? `会话状态 ${record.state ?? record.result.state}`
        : "未提供状态";
};
export function filterProtocolHistory(project, filters = {}) {
  const records = project.protocolRuns || [];
  const query = String(filters.query || "")
    .trim()
    .toLocaleLowerCase();
  return records
    .map((record, index) => ({ record, index }))
    .filter(
      ({ record }) =>
        (!filters.type || (record.type || "未知协议") === filters.type) &&
        (!filters.status || String(statusText(record)) === filters.status) &&
        (!query || JSON.stringify(record).toLocaleLowerCase().includes(query)),
    )
    .map(({ index }) => index);
}
export function applyProtocolHistoryFilters(root, project) {
  if (!root || root.dataset.protocolProject !== project?.id) return false;
  const matching = new Set(
    filterProtocolHistory(project, {
      query: root.querySelector("#protocol-history-query").value,
      type: root.querySelector("#protocol-history-type").value,
      status: root.querySelector("#protocol-history-status").value,
    }),
  );
  for (const card of root.querySelectorAll("[data-protocol-row]"))
    card.hidden = !matching.has(Number(card.dataset.protocolRow));
  root.querySelector("#protocol-history-count").textContent =
    `显示 ${matching.size} / ${(project.protocolRuns || []).length} 条已加载记录`;
  root.querySelector("#protocol-history-empty").hidden = matching.size !== 0;
  return true;
}
export function protocolHistoryView(project) {
  const records = project.protocolRuns || [];
  const options = (values) =>
    [...new Set(values)]
      .map((value) => `<option value="${esc(value)}">${esc(value)}</option>`)
      .join("");
  return `<section id="protocol-history" data-protocol-project="${esc(project.id)}"><h2>已保存协议记录</h2><p class="notice">仅查看本项目已保存的证据，不重新连接或发送。消息正文可能敏感，未脱敏；本地发送和确认不证明远端业务成功。未显示的记录不代表远端未执行。</p>
  <form id="protocol-history-filter" class="row"><label>协议 <select id="protocol-history-type"><option value="">全部协议</option>${options(records.map((r) => r.type || "未知协议"))}</select></label><label>记录状态 <select id="protocol-history-status"><option value="">全部状态</option>${options(records.map((r) => String(statusText(r))))}</select></label><label>原始记录关键词 <input id="protocol-history-query" type="search" maxlength="200" placeholder="在已加载的完整记录中查找"></label><button type="submit">筛选</button><button type="button" id="protocol-history-filter-clear">清除筛选</button></form>
  <p class="subtle">筛选仅作用于当前已加载记录，不查询服务器、不修改记录。重新加载或离开页面会清除筛选。</p><p id="protocol-history-count" role="status">显示 ${records.length} / ${records.length} 条已加载记录</p>
  ${records.map((record, index) => `<div class="card" data-protocol-row="${index}"><strong>${esc(record.type || "未知协议")}</strong> · ${esc(statusText(record))}<p>${esc(record.createdAt)} · ${esc(record.runId || record.id)}</p><button data-protocol-history="${esc(identity(record))}" data-protocol-project="${esc(project.id)}" ${identity(record) ? "" : "disabled"}>查看完整记录</button><button data-protocol-history-export="${esc(identity(record))}" data-protocol-project="${esc(project.id)}" ${identity(record) ? "" : "disabled"}>导出记录…</button></div>`).join("")}
  <p id="protocol-history-empty" ${records.length ? "hidden" : ""}>暂无符合筛选的已保存协议记录</p></section>`;
}
export function protocolHistoryDetail(project, projectId, recordId) {
  if (
    !project ||
    project.id !== projectId ||
    typeof recordId !== "string" ||
    !recordId
  )
    return null;
  const matches = (project.protocolRuns || []).filter(
    (r) => identity(r) === recordId,
  );
  if (matches.length !== 1) return null;
  const record = matches[0];
  return `<p class="notice">已保存的原始记录，仅供查看。正文未脱敏；不会重放网络操作。</p><pre id="protocol-history-detail">${esc(JSON.stringify(record, null, 2))}</pre>`;
}

export function prepareProtocolHistoryExport(project, projectId, recordId) {
  if (protocolHistoryDetail(project, projectId, recordId) === null) return null;
  const record = project.protocolRuns.find((r) => identity(r) === recordId);
  const serialized = JSON.stringify(record);
  return {
    preview: protocolHistoryDetail(project, projectId, recordId),
    confirm(currentProject) {
      if (protocolHistoryDetail(currentProject, projectId, recordId) === null)
        throw Error("项目或记录已变化，请重新选择导出");
      const current = currentProject.protocolRuns.find(
        (r) => identity(r) === recordId,
      );
      if (JSON.stringify(current) !== serialized)
        throw Error("记录已变化，请重新预览后导出");
      return JSON.parse(serialized);
    },
  };
}
