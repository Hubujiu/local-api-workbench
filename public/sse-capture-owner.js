const terminal = new Set(["completed", "partial", "failed", "cancelled"]);
const waiting = new Set(["running", "stopping"]);
const ownerKey = ({ projectId, definitionId }) =>
  JSON.stringify([projectId, definitionId]);

export function createSSECaptureOwner() {
  const attempts = new Map();
  const current = (owner) => owner && attempts.get(ownerKey(owner));
  const owns = (attempt) => current(attempt.owner) === attempt;
  return {
    current,
    abandon(attempt) {
      if (
        !attempt ||
        !owns(attempt) ||
        attempt.phase !== "unknown" ||
        attempt.checking
      )
        return false;
      return attempts.delete(ownerKey(attempt.owner));
    },
    start(owner, { runId, url }) {
      if (
        Array.from(attempts.values()).some((attempt) =>
          waiting.has(attempt.phase),
        )
      )
        return null;
      const key = ownerKey(owner);
      if (attempts.get(key)?.phase === "unknown") return null;
      if (!attempts.has(key) && attempts.size === 4) {
        const settled = [...attempts].find(([, attempt]) =>
          terminal.has(attempt.phase),
        );
        if (!settled) return null;
        attempts.delete(settled[0]);
      }
      attempts.delete(key);
      const attempt = {
        owner: Object.freeze({ ...owner }),
        dispatch: Object.freeze({ runId, url }),
        phase: "running",
      };
      attempts.set(key, attempt);
      return attempt;
    },
    cancel(attempt) {
      if (!attempt || !owns(attempt) || attempt.phase !== "running")
        return false;
      attempt.phase = "stopping";
      return true;
    },
    settle(attempt, receipt) {
      if (!owns(attempt) || !waiting.has(attempt.phase)) return;
      const exact = receipt?.runId === attempt.dispatch.runId;
      if (exact)
        attempt.recordId = receipt.attemptedRecordId || receipt.recordId;
      if (!exact || receipt.recordSaved !== true || !receipt.recordId) {
        attempt.phase = "unknown";
        return;
      }
      if (attempt.phase === "stopping") {
        attempt.phase = "unknown";
        return;
      }
      attempt.phase = receipt.error
        ? "failed"
        : receipt.cancelled
          ? "cancelled"
          : receipt.timedOut || receipt.limited
            ? "partial"
            : "completed";
      attempt.result = receipt.error
        ? { error: receipt.error }
        : {
            status: receipt.status,
            events: receipt.events,
            timedOut: receipt.timedOut,
            limited: receipt.limited,
          };
    },
    check(attempt, records) {
      if (
        !owns(attempt) ||
        attempt.phase !== "unknown" ||
        !Array.isArray(records)
      )
        return false;
      const matches = records.filter(
        (record) =>
          record?.runId === attempt.dispatch.runId &&
          typeof record.id === "string" &&
          record.id.length > 0 &&
          record.type === "sse" &&
          record.definition?.type === "sse" &&
          record.definition.url === attempt.dispatch.url &&
          (!attempt.recordId || record.id === attempt.recordId) &&
          terminal.has(record.status),
      );
      if (matches.length !== 1) return false;
      attempt.phase = matches[0].status;
      attempt.recordId = matches[0].id;
      attempt.result =
        matches[0].result ??
        (matches[0].error ? { error: matches[0].error } : null);
      return true;
    },
  };
}

export function sseCaptureView(attempt, savedUrl) {
  const previousTarget =
    attempt &&
    savedUrl !== undefined &&
    savedUrl !== attempt.owner.definitionUrl &&
    savedUrl !== attempt.dispatch.url;
  const notice = {
    running: "正在采集 SSE 事件…",
    stopping: "已请求断开，正在等待本机结果…",
    unknown:
      attempt?.reconciliationMissed && !attempt.checking
        ? "未核对到这一笔采集的已保存记录；不能据此判断未执行，请勿重发。"
        : "结果待核对；没有记录不代表未执行，请勿重发。",
    completed: "采集完成 · 本机记录已保存",
    partial: "采集已结束（保留部分事件）· 本机记录已保存",
    failed: "采集失败 · 本机记录已保存",
    cancelled: "采集已取消 · 本机记录已保存",
  }[attempt?.phase];
  return {
    notice: notice || "",
    targetNote: previousTarget
      ? "保存的地址已更改；此状态属于之前的采集，不代表当前地址已执行。"
      : "",
    result:
      !previousTarget && attempt?.result
        ? JSON.stringify(attempt.result, null, 2)
        : "",
    canCancel: attempt?.phase === "running",
    needsCheck: attempt?.phase === "unknown",
    canCheck: attempt?.phase === "unknown" && !attempt.checking,
    blocksStart: attempt?.phase === "unknown",
  };
}
