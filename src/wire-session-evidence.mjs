import { normalizeProtocol } from "./protocol-definitions.mjs";
import { protocolEvidenceHash } from "./wire-evidence.mjs";
import { createHash } from "node:crypto";
const plain = (x) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(x));
const text = (x, n) =>
  typeof x === "string" && x.isWellFormed() && x.length <= n;
const only = (x, keys) =>
  plain(x) && Object.keys(x).every((k) => keys.includes(k));
export function makeWireSessionRecord(session, snapshot) {
  const truncated = Boolean(
    snapshot.overflow ||
      snapshot.droppedEvents ||
      snapshot.events.some((event) => event.truncated),
  );
  const status =
    snapshot.state === "error"
      ? "failed"
      : truncated || snapshot.closeReason !== "remote"
        ? "partial"
        : "completed";
  const record = {
    id: session.id,
    runId: session.id,
    mode: "session",
    type: session.type,
    createdAt: snapshot.createdAt,
    finishedAt: snapshot.finishedAt,
    durationMs: Math.max(
      0,
      Date.parse(snapshot.finishedAt) - Date.parse(snapshot.createdAt),
    ),
    definition: structuredClone(session.definition),
    definitionHash: protocolEvidenceHash(session.definition),
    result: { ...snapshot, resultTruncated: truncated },
    resultHash: null,
    status,
  };
  record.resultHash = protocolEvidenceHash(record.result);
  validateWireSessionRecord(record);
  return record;
}
export function validateWireSessionRecord(record) {
  if (
    !only(record, [
      "id",
      "runId",
      "mode",
      "type",
      "createdAt",
      "finishedAt",
      "durationMs",
      "definition",
      "definitionHash",
      "result",
      "resultHash",
      "status",
    ]) ||
    record.mode !== "session" ||
    !["tcp", "websocket", "sse"].includes(record.type) ||
    !text(record.id, 200) ||
    !record.id ||
    record.runId !== record.id ||
    !text(record.createdAt, 64) ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !text(record.finishedAt, 64) ||
    !Number.isFinite(Date.parse(record.finishedAt)) ||
    !Number.isFinite(record.durationMs) ||
    record.durationMs < 0
  )
    throw Error("交互协议记录格式无效");
  const definition = normalizeProtocol(record.definition);
  if (
    definition.type !== record.type ||
    protocolEvidenceHash(definition) !== record.definitionHash ||
    protocolEvidenceHash(record.definition) !== record.definitionHash
  )
    throw Error("交互协议定义哈希无效");
  const r = record.result;
  if (
    !only(r, [
      "id",
      "type",
      "state",
      "events",
      "createdAt",
      "finishedAt",
      "closeReason",
      "totalEvents",
      "droppedEvents",
      "dataBytes",
      "overflow",
      "error",
      "resultTruncated",
    ]) ||
    r.id !== record.id ||
    r.type !== record.type ||
    r.createdAt !== record.createdAt ||
    r.finishedAt !== record.finishedAt ||
    !["closed", "error"].includes(r.state) ||
    !["manual", "remote", "deadline", "error"].includes(r.closeReason) ||
    !Array.isArray(r.events) ||
    r.events.length > 200 ||
    !Number.isSafeInteger(r.totalEvents) ||
    r.totalEvents < r.events.length ||
    r.droppedEvents !== r.totalEvents - r.events.length ||
    !Number.isInteger(r.dataBytes) ||
    r.dataBytes < 0 ||
    r.dataBytes > 8 * 1024 * 1024 ||
    typeof r.overflow !== "boolean" ||
    (r.error !== undefined && !text(r.error, 1000))
  )
    throw Error("交互协议终态或事件统计无效");
  if (
    (r.state === "error") !== (r.closeReason === "error") ||
    (r.state !== "error" && r.error !== undefined)
  )
    throw Error("交互协议错误终态不一致");
  const ids = new Set();
  let retainedBytes = 0;
  for (const event of r.events) {
    if (
      !only(event, [
        "id",
        "direction",
        "data",
        "dataBytes",
        "dataHash",
        "truncated",
        "at",
        "encoding",
        "sendState",
        "sse",
      ]) ||
      !text(event.id, 200) ||
      !event.id ||
      ids.has(event.id) ||
      !["sent", "received", "error"].includes(event.direction) ||
      !text(event.data, 100000) ||
      !Number.isInteger(event.dataBytes) ||
      event.dataBytes < Buffer.byteLength(event.data) ||
      event.dataBytes > 8 * 1024 * 1024 ||
      !/^([0-9a-f]{64})$/.test(event.dataHash) ||
      typeof event.truncated !== "boolean" ||
      !text(event.at, 64) ||
      !Number.isFinite(Date.parse(event.at)) ||
      (event.encoding !== undefined &&
        !["utf8", "base64", "hex"].includes(event.encoding)) ||
      (event.sendState !== undefined &&
        !["queued", "written", "failed"].includes(event.sendState))
    )
      throw Error("交互协议事件无效");
    ids.add(event.id);
    retainedBytes += event.dataBytes;
    if (
      !event.truncated &&
      (event.dataBytes !== Buffer.byteLength(event.data) ||
        createHash("sha256").update(event.data).digest("hex") !==
          event.dataHash)
    )
      throw Error("交互协议事件哈希无效");
    if (event.truncated && event.dataBytes <= Buffer.byteLength(event.data))
      throw Error("交互协议截断标记无效");
    if (
      event.sse !== undefined &&
      (!only(event.sse, ["event", "id", "retry"]) ||
        record.type !== "sse" ||
        !text(event.sse.event, 1048576) ||
        !text(event.sse.id, 1048576) ||
        (event.sse.retry !== undefined &&
          (!Number.isSafeInteger(event.sse.retry) || event.sse.retry < 0)))
    )
      throw Error("交互 SSE 元数据无效");
  }
  if (retainedBytes > r.dataBytes) throw Error("交互协议数据计数不一致");
  const truncated = Boolean(
    r.overflow || r.droppedEvents || r.events.some((event) => event.truncated),
  );
  const status =
    r.state === "error"
      ? "failed"
      : truncated || r.closeReason !== "remote"
        ? "partial"
        : "completed";
  if (
    record.status !== status ||
    r.resultTruncated !== truncated ||
    protocolEvidenceHash(r) !== record.resultHash
  )
    throw Error("交互协议结果状态或哈希不一致");
  if (r.state === "error" && !r.error) throw Error("交互协议失败缺少错误信息");
  if (Buffer.byteLength(JSON.stringify(record)) > 3 * 1024 * 1024)
    throw Error("交互协议记录超过3MiB");
}
export async function finalizeWireSession(store, projectId, session, snapshot) {
  session.finalRecord ??= makeWireSessionRecord(session, snapshot);
  const record = session.finalRecord;
  const existing = (await store.get(projectId)).protocolRuns?.find(
    (x) => x.id === record.id,
  );
  if (existing) {
    if (
      existing.definitionHash !== record.definitionHash ||
      existing.resultHash !== record.resultHash
    )
      throw Error("协议记录ID冲突，不能覆盖已有证据");
    return record.id;
  }
  await store.append(projectId, "protocolRuns", record);
  return record.id;
}
