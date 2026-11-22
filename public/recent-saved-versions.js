export function validateSavedVersionSummary(data, projectId) {
  const counters = ["configRevision", "tracked", "untracked"];
  if (
    data?.projectId !== projectId ||
    counters.some((key) => !Number.isSafeInteger(data[key]) || data[key] < 0) ||
    !Array.isArray(data.rows) ||
    data.rows.length !== Math.min(data.tracked, 50)
  )
    throw Error("收到的已保存版本不属于当前项目或格式不完整");
  const identifiers = new Set();
  for (const row of data.rows) {
    if (
      typeof row?.requestId !== "string" ||
      !row.requestId ||
      identifiers.has(row.requestId) ||
      typeof row.name !== "string" ||
      typeof row.method !== "string" ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      typeof row.currentCreatedAt !== "string" ||
      !Number.isFinite(Date.parse(row.currentCreatedAt))
    )
      throw Error("收到的已保存版本格式不完整");
    identifiers.add(row.requestId);
  }
  return data;
}
