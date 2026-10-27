// A summary never contains requests, responses, assertions, variables, or logs.
export function filteredExecutionHistory(project, options = {}) {
  const { scope, source, status, planId, limit = 20 } = options;
  for (const [value, choices, label] of [
    [scope, ["api", "flow"], "范围"],
    [source, ["manual", "mcp", "cli", "unknown"], "来源"],
    [status, ["passed", "failed", "cancelled"], "状态"],
  ])
    if (value !== undefined && !choices.includes(value))
      throw Error(`执行记录${label}无效`);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw Error("记录条数必须为 1 到 50 的整数");
  const records = [
    ...(project.history || []).map((record) => ({ record, scope: "api" })),
    ...(project.runs || []).map((record) => ({ record, scope: "flow" })),
  ];
  const origin = (record) =>
    ["manual", "mcp", "cli"].includes(record.source)
      ? record.source
      : "unknown";
  const time = (record) => {
    const value = Date.parse(record.createdAt);
    return Number.isFinite(value) ? value : -Infinity;
  };
  return records
    .filter(
      (item) =>
        (!scope || item.scope === scope) &&
        (!source || origin(item.record) === source) &&
        (!status || item.record.status === status) &&
        (!planId || (item.scope === "flow" && item.record.planId === planId)),
    )
    .sort((a, b) =>
      time(a.record) === time(b.record) ? 0 : time(b.record) - time(a.record),
    );
}
export function listExecutionHistory(project, options = {}) {
  return filteredExecutionHistory(project, options)
    .slice(0, options.limit ?? 20)
    .map(({ record, scope }) => {
      const failures = (
        scope === "api" ? [record] : record.results || []
      ).filter((step) => step.status === "failed");
      return {
        id: record.id,
        scope,
        source: ["manual", "mcp", "cli"].includes(record.source)
          ? record.source
          : "unknown",
        name: scope === "api" ? record.name : record.planName,
        planId: scope === "flow" ? record.planId : undefined,
        planName: scope === "flow" ? record.planName : undefined,
        planHash: scope === "flow" ? record.planHash : undefined,
        status: record.status,
        createdAt: record.createdAt,
        durationMs:
          Number.isFinite(record.durationMs) && record.durationMs >= 0
            ? record.durationMs
            : undefined,
        failedStepCount: failures.length,
        failedSteps: failures.slice(0, 5).map((step) => ({
          stepId: step.stepId,
          name: step.name,
          status: step.status,
        })),
      };
    });
}
export function findExecutionResult(project, runId) {
  const found = [...(project.runs || []), ...(project.history || [])].filter(
    (record) => record.id === runId,
  );
  if (found.length > 1) throw Error("记录 ID 不唯一");
  if (!found.length) throw Error("记录不存在");
  return found[0];
}
