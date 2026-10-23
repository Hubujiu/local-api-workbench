export function caseEvidence(result) {
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (bytes <= 65536) return result;
  const text = (value, limit) => {
    let out = "",
      size = 0;
    for (const char of String(value ?? "")) {
      const n = new TextEncoder().encode(JSON.stringify(char)).byteLength - 2;
      if (size + n > limit) break;
      out += char;
      size += n;
    }
    return out;
  };
  const failures = (result.assertions || []).filter((a) => a.passed === false);
  return {
    outcome: result.outcome,
    status: result.status,
    protocol: result.protocol,
    size: result.size,
    duration: result.duration,
    error: text(result.error, 2048),
    request: {
      method: text(result.request?.method, 32),
      url: text(result.request?.url, 4096),
    },
    bodyExcerpt: text(result.body, 32768),
    evidenceTruncated: true,
    originalEvidenceBytes: bytes,
    assertionCount: result.assertions?.length || 0,
    failedAssertionCount: failures.length,
    failedAssertions: failures.slice(0, 20).map((a) => ({
      name: text(a.name, 256),
      message: text(a.message, 512),
      passed: false,
    })),
    omittedDetails:
      "批量界面仅保留有界摘要；完整单次证据请查看请求历史，仍遵循历史保留上限。",
  };
}

export async function runCaseBatch(
  items,
  execute,
  { shouldStop = () => false, onProgress = () => {} } = {},
) {
  if (
    !Array.isArray(items) ||
    !items.length ||
    items.length > 100 ||
    items.some(
      (item) =>
        !item ||
        typeof item.id !== "string" ||
        !item.id ||
        !item.request ||
        typeof item.request !== "object" ||
        Array.isArray(item.request),
    ) ||
    new Set(items.map((i) => i.id)).size !== items.length
  )
    throw Error("单次运行须选择1至100个不同用例");
  let sourceBytes = 0;
  for (const item of items) {
    sourceBytes += new TextEncoder().encode(JSON.stringify(item)).byteLength;
    if (sourceBytes > 4 * 1024 * 1024)
      throw Error("批次请求快照总量最多4MiB，请分批或单条运行");
  }
  const snapshots = structuredClone(items),
    state = {
      total: snapshots.length,
      completed: 0,
      passed: 0,
      failed: 0,
      cancelled: false,
      stoppedOnError: false,
      results: [],
    };
  const report = (item) =>
    onProgress({
      total: state.total,
      completed: state.completed,
      passed: state.passed,
      failed: state.failed,
      cancelled: state.cancelled,
      stoppedOnError: state.stoppedOnError,
      currentId: item?.id,
      currentName: item?.name,
    });
  for (const item of snapshots) {
    if (shouldStop()) {
      state.cancelled = true;
      break;
    }
    report(item);
    try {
      const result = caseEvidence(await execute(item));
      state.results.push({ id: item.id, result });
      if (result?.outcome === "passed") state.passed++;
      else state.failed++;
      state.completed++;
    } catch (error) {
      state.results.push({
        id: item.id,
        error: String(error?.message || error),
      });
      state.failed++;
      state.completed++;
      state.stoppedOnError = true;
      break;
    }
  }
  if (shouldStop() && state.completed < state.total) state.cancelled = true;
  report();
  return state;
}
