import { createHash } from "node:crypto";
import {
  GRPC_MAX_BYTES,
  normalizeGrpcDefinition,
  selectGrpcMethod,
  prepareGrpcMessage,
} from "./grpc.mjs";
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const only = (value, keys) =>
  plain(value) && Object.keys(value).every((key) => keys.includes(key));
const text = (value, max) =>
  typeof value === "string" && value.isWellFormed() && value.length <= max;
const date = (value) => text(value, 64) && Number.isFinite(Date.parse(value));
const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= GRPC_MAX_BYTES;
const status = (value) =>
  only(value, ["code", "details"]) &&
  Number.isInteger(value.code) &&
  value.code >= 0 &&
  value.code <= 16 &&
  text(value.details, 2000);
export const grpcSessionHash = (value) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        plain(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest("hex");
const classify = (result) =>
  result.terminationReason === "remote" && result.status.code === 0
    ? "completed"
    : ["cancel", "deadline", "shutdown", "limit"].includes(
          result.terminationReason,
        )
      ? "partial"
      : "failed";
export function makeGrpcSessionRecord(definition, result) {
  const record = {
    id: result.id,
    runId: result.id,
    mode: "session",
    type: "grpc",
    createdAt: result.createdAt,
    finishedAt: result.finishedAt,
    definition: structuredClone(definition),
    definitionHash: grpcSessionHash(definition),
    result: structuredClone(result),
    resultHash: grpcSessionHash(result),
    status: classify(result),
  };
  validateGrpcSessionRecord(record);
  return record;
}
export function grpcSessionMessageBytes(value) {
  if (!plain(value)) throw Error("gRPC响应记录必须为JSON对象");
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 100000 || depth > 64) throw Error("gRPC响应记录结构超限");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item === "string" && item.isWellFormed()) return;
    if (!plain(item) && !Array.isArray(item))
      throw Error("gRPC响应记录含非JSON值");
    for (const [key, entry] of Object.entries(item)) {
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw Error("gRPC响应记录含保留字段");
      visit(entry, depth + 1);
    }
  };
  visit(value, 0);
  return Buffer.byteLength(JSON.stringify(value));
}
export function validateGrpcSessionRecord(record) {
  if (
    !only(record, [
      "id",
      "runId",
      "mode",
      "type",
      "createdAt",
      "finishedAt",
      "definition",
      "definitionHash",
      "result",
      "resultHash",
      "status",
    ]) ||
    record.mode !== "session" ||
    record.type !== "grpc" ||
    !text(record.id, 200) ||
    !record.id ||
    record.runId !== record.id ||
    !date(record.createdAt) ||
    !date(record.finishedAt)
  )
    throw Error("gRPC交互记录格式无效");
  const definition = normalizeGrpcDefinition(record.definition),
    selected = selectGrpcMethod(definition),
    { desc } = selected;
  if (
    (!desc.requestStream && !desc.responseStream) ||
    grpcSessionHash(definition) !== record.definitionHash ||
    grpcSessionHash(record.definition) !== record.definitionHash
  )
    throw Error("gRPC交互定义或哈希无效");
  const r = record.result;
  if (
    !only(r, [
      "id",
      "type",
      "definitionId",
      "definitionHash",
      "lifecycle",
      "requestState",
      "createdAt",
      "finishedAt",
      "durationMs",
      "deadlineAt",
      "service",
      "method",
      "path",
      "streaming",
      "requestMessages",
      "messages",
      "requestBytes",
      "requestWireBytes",
      "responseBytes",
      "status",
      "remoteStatus",
      "terminationReason",
      "truncated",
      "callback",
      "responseEnded",
      "transportError",
    ]) ||
    r.id !== record.id ||
    r.type !== "grpc" ||
    r.definitionId !== definition.id ||
    r.definitionHash !== record.definitionHash ||
    r.lifecycle !== "terminal" ||
    !["halfClosed", "unavailable"].includes(r.requestState) ||
    r.createdAt !== record.createdAt ||
    r.finishedAt !== record.finishedAt ||
    !Number.isFinite(r.durationMs) ||
    r.durationMs < 0 ||
    !date(r.deadlineAt) ||
    Date.parse(r.deadlineAt) - Date.parse(r.createdAt) !==
      definition.timeoutMs ||
    r.service !== definition.service ||
    r.method !== definition.method ||
    r.path !== desc.path ||
    !only(r.streaming, ["request", "response"]) ||
    r.streaming.request !== desc.requestStream ||
    r.streaming.response !== desc.responseStream ||
    !Array.isArray(r.requestMessages) ||
    r.requestMessages.length > 100 ||
    !Array.isArray(r.messages) ||
    r.messages.length > 100 ||
    !count(r.requestBytes) ||
    !count(r.requestWireBytes) ||
    !count(r.responseBytes) ||
    !status(r.status) ||
    (r.remoteStatus !== null && !status(r.remoteStatus)) ||
    (r.transportError !== null && !status(r.transportError)) ||
    !["remote", "cancel", "deadline", "limit", "error", "shutdown"].includes(
      r.terminationReason,
    ) ||
    typeof r.truncated !== "boolean" ||
    typeof r.responseEnded !== "boolean"
  )
    throw Error("gRPC交互终态证据无效");
  if (
    r.callback !== null &&
    (!only(r.callback, ["code", "details", "responseReceived"]) ||
      !status({ code: r.callback.code, details: r.callback.details }) ||
      typeof r.callback.responseReceived !== "boolean")
  )
    throw Error("gRPC交互回调证据无效");
  if (desc.responseStream && r.callback !== null)
    throw Error("响应流不应包含单响应回调证据");
  if (
    !desc.responseStream &&
    (r.messages.length > 1 ||
      (r.messages.length &&
        (!r.callback?.responseReceived || r.callback.code !== 0)))
  )
    throw Error("客户端流响应证据不一致");
  if (
    !desc.requestStream &&
    (r.requestMessages.length !== 1 || r.requestState !== "halfClosed")
  )
    throw Error("服务端流请求证据不一致");
  let requestBytes = 0,
    wireBytes = 0;
  for (const entry of r.requestMessages) {
    if (
      !only(entry, ["message", "jsonBytes", "wireBytes", "sendState", "at"]) ||
      !date(entry.at) ||
      !(
        desc.requestStream ? ["accepted", "failed", "unknown"] : ["submitted"]
      ).includes(entry.sendState)
    )
      throw Error("gRPC交互请求发送证据无效");
    const expected = prepareGrpcMessage(selected, entry.message);
    if (
      entry.jsonBytes !== expected.jsonBytes ||
      entry.wireBytes !== expected.wireBytes
    )
      throw Error("gRPC交互请求字节统计不一致");
    requestBytes += entry.jsonBytes;
    wireBytes += entry.wireBytes;
  }
  const responseBytes = r.messages.reduce(
    (sum, message) => sum + grpcSessionMessageBytes(message),
    0,
  );
  if (
    requestBytes !== r.requestBytes ||
    wireBytes !== r.requestWireBytes ||
    responseBytes !== r.responseBytes
  )
    throw Error("gRPC交互消息统计不一致");
  if (r.terminationReason === "remote") {
    if (
      !r.remoteStatus ||
      (desc.responseStream ? !r.responseEnded : !r.callback)
    )
      throw Error("gRPC交互缺少最终远端证据");
    const effective = r.remoteStatus.code
      ? r.remoteStatus
      : r.callback?.code
        ? r.callback
        : r.transportError || r.remoteStatus;
    if (
      r.status.code !== effective.code ||
      r.status.details !== effective.details ||
      (!desc.responseStream &&
        r.status.code === 0 &&
        !r.callback.responseReceived)
    )
      throw Error("gRPC回调与远端状态不一致");
  } else if (r.status.code === 0) throw Error("本地终止不能声称gRPC成功");
  if (
    (["cancel", "shutdown"].includes(r.terminationReason) &&
      r.status.code !== 1) ||
    (r.terminationReason === "deadline" && r.status.code !== 4) ||
    (r.terminationReason === "limit" &&
      (r.status.code !== 8 || !r.truncated)) ||
    (r.terminationReason !== "limit" && r.truncated)
  )
    throw Error("gRPC终止原因与状态不一致");
  if (
    record.status !== classify(r) ||
    grpcSessionHash(r) !== record.resultHash ||
    Buffer.byteLength(JSON.stringify(record)) > 3 * GRPC_MAX_BYTES
  )
    throw Error("gRPC交互记录状态、哈希或大小无效");
}
// Apply on read/restore before retention slicing as well as the general save codec.
export function validateGrpcSessionHistory(records = []) {
  if (!Array.isArray(records)) throw Error("gRPC交互历史必须为数组");
  const identities = new Map();
  for (const record of records)
    if (typeof record?.id === "string")
      identities.set(record.id, (identities.get(record.id) || 0) + 1);
  for (const record of records)
    if (record?.type === "grpc" && record.mode === "session") {
      validateGrpcSessionRecord(record);
      if (identities.get(record.id) !== 1)
        throw Error("gRPC交互记录ID存在歧义");
    }
}
export async function finalizeGrpcSession(store, projectId, record) {
  validateGrpcSessionRecord(record);
  const existing = (await store.get(projectId)).protocolRuns?.find(
    (item) => item.id === record.id,
  );
  if (existing) {
    validateGrpcSessionRecord(existing);
    if (
      existing.definitionHash !== record.definitionHash ||
      existing.resultHash !== record.resultHash
    )
      throw Error("gRPC交互记录ID冲突，不能覆盖既有证据");
    return record.id;
  }
  await store.append(projectId, "protocolRuns", record);
  return record.id;
}
