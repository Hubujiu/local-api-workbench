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
      : "未提供状态";
};
export function protocolHistoryView(project) {
  const records = project.protocolRuns || [];
  return `<section id="protocol-history"><h2>已保存协议记录</h2><p class="notice">仅查看本项目已保存的证据，不重新连接或发送。消息正文可能敏感，未脱敏；本地发送和确认不证明远端业务成功。未显示的记录不代表远端未执行。</p>${records.map((record) => `<div class="card"><strong>${esc(record.type || "未知协议")}</strong> · ${esc(statusText(record))}<p>${esc(record.createdAt)} · ${esc(record.runId || record.id)}</p><button data-protocol-history="${esc(identity(record))}" data-protocol-project="${esc(project.id)}" ${identity(record) ? "" : "disabled"}>查看完整记录</button></div>`).join("") || "<p>暂无已保存协议记录</p>"}</section>`;
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
