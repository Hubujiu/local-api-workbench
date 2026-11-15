// Read-only receipt selection. Never adopt project configuration, revisions,
// fingerprints or write/reconciliation authority from this response.
export function createPlanHistoryRefresh() {
  let sequence = 0;
  return async function refresh({ owner, read, isCurrent }) {
    const request = ++sequence;
    const runs = owner.runs;
    const latest = await read(owner.id);
    if (request !== sequence || owner.runs !== runs || !isCurrent())
      throw Error("页面或执行记录已变化，未替换记录；请重新刷新");
    if (latest?.id !== owner.id || !Array.isArray(latest.runs))
      throw Error("执行记录响应身份或格式不匹配，原记录已保留");
    const ids = new Set();
    for (const run of latest.runs) {
      if (
        !run ||
        typeof run.id !== "string" ||
        !run.id ||
        ids.has(run.id) ||
        !Array.isArray(run.results)
      )
        throw Error("执行记录响应格式无效，原记录已保留");
      ids.add(run.id);
    }
    return structuredClone(latest.runs);
  };
}
