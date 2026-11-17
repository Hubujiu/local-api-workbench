// Presentation only. The server remains authoritative for graph admission.
export function isHTTPPlanStep(step) {
  return (
    (step.type === undefined || step.type === "http") &&
    step.request &&
    typeof step.request === "object" &&
    !Array.isArray(step.request)
  );
}
export function planStepSummary(step) {
  if (isHTTPPlanStep(step))
    return {
      kind: step.request.method || "HTTP",
      detail: step.request.url || "未设置 URL",
    };
  if (step.type === "repeat") {
    const rows = Object.hasOwn(step, "rowsFrom");
    return {
      kind: "循环",
      detail: [
        rows
          ? `运行时数据行，最多 ${step.maxRows} 行`
          : `最多 ${step.count} 次`,
        step.rows ? `固定数据 ${step.rows.length} 行` : "",
        step.untilCondition ? "满足条件后提前结束" : "",
        step.intervalMs ? `间隔 ${step.intervalMs}ms` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  if (step.type === "if")
    return { kind: "条件", detail: "条件成立时执行子步骤" };
  if (step.type === "grpc") {
    const d = step.grpc?.definition;
    return { kind: "gRPC", detail: d?.target || "gRPC 定义快照" };
  }
  if (step.type === "socketio")
    return {
      kind: "Socket.IO",
      detail: step.socketio?.definition?.url || "Socket.IO 定义快照",
    };
  if (step.type === "protocol") {
    const d = step.protocol?.definition;
    return {
      kind: d?.type?.toUpperCase() || "协议",
      detail: d?.url || (d?.host ? `${d.host}:${d.port}` : "协议定义快照"),
    };
  }
  return {
    kind: String(step.type || "未知类型"),
    detail: "保留原始定义，可用 JSON 检查和编辑",
  };
}
export function parsePlanStepJSON(step, text) {
  const limit = 4 * 1024 * 1024;
  if (text.length > limit || new TextEncoder().encode(text).length > limit)
    throw Error("步骤 JSON 不能超过 4MiB");
  const candidate = JSON.parse(text);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    throw Error("步骤 JSON 须为对象");
  if (candidate.id !== step.id || candidate.type !== step.type)
    throw Error("请保留此步骤的 ID 和类型；结构重建请使用计划 JSON 编辑器");
  return candidate;
}
