import {
  protocolTemplateContext,
  resolveProtocolDefinition,
  validateTemplateProvenance,
} from "./protocol-text-templates.mjs";
import { protocolRequestOptions } from "./protocol-request-options.mjs";
import { websocketConfiguration } from "./websocket-client.mjs";
import { decodeISO8583 } from "./iso8583-codec.mjs";
import { createHash, randomUUID } from "node:crypto";
import { normalizeProtocol } from "./protocol-definitions.mjs";
import { protocolPayload } from "./protocol-payload.mjs";
const TYPES = ["tcp", "websocket", "sse"];
const plain = (x) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(x));
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    plain(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
export const protocolEvidenceHash = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const text = (value, max = 1048576) =>
  typeof value === "string" && value.isWellFormed() && value.length <= max;
function only(value, keys) {
  return plain(value) && Object.keys(value).every((key) => keys.includes(key));
}
export function prepareWireExecution(project, input) {
  if (!plain(input)) throw Error("协议调用参数无效");
  let saved;
  if (input.definitionId !== undefined) {
    if (typeof input.definitionId !== "string") throw Error("协议定义ID无效");
    saved = (project.protocols || []).find((x) => x.id === input.definitionId);
    if (!saved) throw Error("协议定义不存在或不属于此项目");
    if (
      [
        "url",
        "host",
        "port",
        "method",
        "body",
        "completion",
        "templateMode",
      ].some((key) => input[key] !== undefined) ||
      (input.type !== undefined && input.type !== saved.type)
    )
      throw Error("已保存协议定义不能在调用时替换端点");
  }
  const type = saved?.type ?? input.type;
  if (!TYPES.includes(type)) throw Error("未知协议");
  if (
    type !== "websocket" &&
    (input.tls !== undefined || input.protocols !== undefined)
  )
    throw Error("该协议不支持 WebSocket TLS/子协议配置");
  if (type === "tcp" && input.headers !== undefined)
    throw Error("TCP 不支持 HTTP Headers");
  const sourceDefinition = normalizeProtocol({
    ...(saved || {}),
    type,
    ...((saved?.templateMode ?? input.templateMode) !== undefined
      ? { templateMode: saved?.templateMode ?? input.templateMode }
      : {}),
    ...protocolRequestOptions(saved || input),
    name: saved?.name ?? input.name,
    url: saved?.url ?? (type === "tcp" ? input.host : input.url),
    ...(type === "tcp"
      ? {
          port: saved?.port ?? input.port,
          receiveEncoding: saved?.receiveEncoding,
        }
      : {}),
    ...(type !== "sse"
      ? {
          message: structuredClone(
            input.message !== undefined
              ? input.message
              : (saved?.message ?? ""),
          ),
        }
      : {}),
  });
  const context =
    sourceDefinition.templateMode === "variables"
      ? protocolTemplateContext(project, input.environmentId)
      : undefined;
  const definition = context
    ? resolveProtocolDefinition(sourceDefinition, context.variables)
    : sourceDefinition;
  const templateProvenance = context
    ? {
        sourceDefinitionHash: protocolEvidenceHash(sourceDefinition),
        environmentId: context.environmentId,
      }
    : undefined;
  const duration = Math.min(
    30000,
    Math.max(100, Number(input.duration ?? definition.duration) || 3000),
  );
  const limit = (value) =>
    Number.isFinite(Number(value))
      ? Math.min(100, Math.max(1, Math.floor(Number(value))))
      : 20;
  const options = {
    duration,
    ...(type === "sse" ? { maxEvents: limit(input.maxEvents) } : {}),
    ...(type === "websocket" ? { maxMessages: limit(input.maxMessages) } : {}),
  };
  const request = {
    ...input,
    ...protocolRequestOptions(definition),
    ...options,
    type,
    ...(definition.templateMode !== undefined
      ? { templateMode: definition.templateMode }
      : {}),
    ...(type === "tcp"
      ? {
          host: definition.url,
          port: definition.port,
          receiveEncoding: definition.receiveEncoding,
        }
      : { url: definition.url }),
    ...(type !== "sse" ? { message: definition.message } : {}),
  };
  if (type === "websocket") {
    const config = websocketConfiguration(request);
    options.requestedProtocols = [...config.protocols];
    options.headerNames = Object.keys(config.options.headers)
      .map((name) => name.toLowerCase())
      .sort();
    options.tlsMode = request.tls?.cert
      ? "mtls"
      : request.tls?.ca
        ? "custom-ca"
        : "default";
  }
  return {
    definition,
    ...(context
      ? {
          templateContext: {
            ...context,
            defaultMessage: sourceDefinition.message,
          },
          templateProvenance,
        }
      : {}),
    definitionHash: protocolEvidenceHash(definition),
    options,
    request,
    requestHash:
      type === "sse"
        ? null
        : createHash("sha256")
            .update(protocolPayload(definition.message).buffer)
            .digest("hex"),
  };
}
export function makeWireRecord(
  prepared,
  runId,
  startedAt,
  result,
  error,
  cancelled,
) {
  let evidence = result ? structuredClone(result) : null;
  if (evidence && prepared.definition.type === "tcp") delete evidence.body; // base64 is the exact nonredundant wire evidence.
  if (
    !error &&
    !result?.partial &&
    !result?.timedOut &&
    !result?.limited &&
    result?.decodeError
  )
    error = Error(result.decodeError);
  const record = {
    id: randomUUID(),
    runId,
    type: prepared.definition.type,
    createdAt: new Date().toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
    definition: prepared.definition,
    ...(prepared.templateProvenance
      ? { templateProvenance: prepared.templateProvenance }
      : {}),
    definitionHash: prepared.definitionHash,
    requestHash: prepared.requestHash,
    options: prepared.options,
    status: cancelled
      ? "cancelled"
      : error
        ? "failed"
        : result?.timedOut || result?.limited || result?.partial
          ? "partial"
          : "completed",
    result: evidence,
    resultHash: protocolEvidenceHash(evidence),
    ...(error || cancelled
      ? {
          error: String(error?.message || error || "协议调用已取消").slice(
            0,
            4096,
          ),
        }
      : {}),
  };
  validateWireRecord(record);
  return record;
}
export function validateWireRecord(record) {
  if (
    !only(record, [
      "id",
      "runId",
      "type",
      "createdAt",
      "startedAt",
      "durationMs",
      "definition",
      "definitionHash",
      "templateProvenance",
      "requestHash",
      "options",
      "status",
      "result",
      "resultHash",
      "error",
    ]) ||
    !TYPES.includes(record.type) ||
    !text(record.id, 200) ||
    !record.id ||
    !text(record.runId, 100) ||
    !/^[A-Za-z0-9_-]+$/.test(record.runId) ||
    !["completed", "partial", "failed", "cancelled"].includes(record.status) ||
    !text(record.createdAt, 64) ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !text(record.startedAt, 64) ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    !Number.isFinite(record.durationMs) ||
    record.durationMs < 0
  )
    throw Error("通用协议执行记录格式无效");
  if (protocolEvidenceHash(record.result) !== record.resultHash)
    throw Error("协议响应哈希不一致");
  const definition = normalizeProtocol(record.definition);
  if (
    definition.type !== record.type ||
    canonical(definition) !== canonical(record.definition) ||
    protocolEvidenceHash(definition) !== record.definitionHash
  )
    throw Error("协议执行定义或哈希不一致");
  validateTemplateProvenance(record.templateProvenance, definition);
  const requestHash =
    record.type === "sse"
      ? null
      : createHash("sha256")
          .update(protocolPayload(definition.message).buffer)
          .digest("hex");
  if (record.requestHash !== requestHash) throw Error("协议请求字节哈希不一致");
  if (
    !only(record.options, [
      "duration",
      "maxEvents",
      "maxMessages",
      "requestedProtocols",
      "headerNames",
      "tlsMode",
    ]) ||
    !Number.isFinite(record.options.duration) ||
    record.options.duration < 100 ||
    record.options.duration > 30000
  )
    throw Error("协议执行选项无效");
  for (const key of ["maxEvents", "maxMessages"])
    if (
      record.options[key] !== undefined &&
      (!Number.isInteger(record.options[key]) ||
        record.options[key] < 1 ||
        record.options[key] > 100)
    )
      throw Error("协议记录数量限制无效");
  if (record.type === "websocket") {
    if (
      !Array.isArray(record.options.requestedProtocols) ||
      record.options.requestedProtocols.length > 10 ||
      record.options.requestedProtocols.some((x) => !text(x, 128)) ||
      !Array.isArray(record.options.headerNames) ||
      record.options.headerNames.length > 50 ||
      record.options.headerNames.some((x) => !text(x, 256)) ||
      !["default", "custom-ca", "mtls"].includes(record.options.tlsMode)
    )
      throw Error("WebSocket 请求元信息无效");
  } else if (
    ["requestedProtocols", "headerNames", "tlsMode"].some(
      (key) => record.options[key] !== undefined,
    )
  )
    throw Error("协议请求元信息类型不符");
  if (record.error !== undefined && !text(record.error, 4096))
    throw Error("协议执行错误无效");
  if (record.result === null) {
    if (!["failed", "cancelled"].includes(record.status) || !record.error)
      throw Error("协议失败记录缺少错误");
  } else {
    const r = record.result;
    if (record.type === "tcp") {
      if (
        !only(r, [
          "base64",
          "size",
          "timedOut",
          "partial",
          "decoded",
          "decodeError",
        ]) ||
        !text(r.base64, 1400000) ||
        !Number.isInteger(r.size) ||
        r.size < 0 ||
        r.size > 1048576 ||
        Buffer.from(r.base64, "base64").toString("base64") !== r.base64 ||
        Buffer.from(r.base64, "base64").length !== r.size ||
        typeof r.timedOut !== "boolean" ||
        typeof r.partial !== "boolean" ||
        (r.decodeError !== undefined && !text(r.decodeError, 4096))
      )
        throw Error("TCP 执行证据无效");
      if (definition.message?.format === "iso8583") {
        let decoded;
        try {
          decoded = decodeISO8583(
            definition.message.profile,
            Buffer.from(r.base64, "base64"),
          );
        } catch {}
        if (decoded) {
          if (
            canonical(decoded) !== canonical(r.decoded) ||
            r.decodeError !== undefined
          )
            throw Error("ISO8583 解码证据不一致");
        } else if (r.decoded !== undefined || !r.decodeError)
          throw Error("ISO8583 解码失败证据缺失");
      } else if (r.decoded !== undefined || r.decodeError !== undefined)
        throw Error("TCP 解码证据未声明配置");
    } else if (record.type === "sse") {
      if (
        !only(r, ["status", "events", "limited", "timedOut", "cancelled"]) ||
        r.status !== 200 ||
        !Array.isArray(r.events) ||
        r.events.length > 100
      )
        throw Error("SSE 执行证据无效");
      for (const key of ["limited", "timedOut", "cancelled"])
        if (r[key] !== undefined && typeof r[key] !== "boolean")
          throw Error("SSE 边界标记无效");
      for (const event of r.events)
        if (
          !only(event, ["event", "id", "data", "retry", "receivedAt"]) ||
          !text(event.event) ||
          !text(event.id) ||
          !text(event.data) ||
          !Number.isFinite(Date.parse(event.receivedAt)) ||
          (event.retry !== undefined &&
            (!Number.isSafeInteger(event.retry) || event.retry < 0))
        )
          throw Error("SSE 事件证据无效");
    } else {
      if (
        !only(r, [
          "messages",
          "protocol",
          "timedOut",
          "limited",
          "closeCode",
          "closeReason",
        ]) ||
        !Array.isArray(r.messages) ||
        r.messages.length > 100 ||
        !text(r.protocol, 128) ||
        typeof r.timedOut !== "boolean" ||
        (r.limited !== undefined && typeof r.limited !== "boolean") ||
        (r.closeCode !== undefined && !Number.isInteger(r.closeCode)) ||
        (r.closeReason !== undefined && !text(r.closeReason, 123))
      )
        throw Error("WebSocket 执行证据无效");
      for (const event of r.messages)
        if (
          !only(event, ["data", "encoding", "receivedAt"]) ||
          !text(event.data, 1400000) ||
          !["utf8", "base64"].includes(event.encoding) ||
          !Number.isFinite(Date.parse(event.receivedAt)) ||
          (event.encoding === "base64" &&
            Buffer.from(event.data, "base64").toString("base64") !== event.data)
        )
          throw Error("WebSocket 消息证据无效");
    }
    if (["failed", "cancelled"].includes(record.status) && !record.error)
      throw Error("协议失败记录缺少错误说明");
    if (record.status === "completed" && (record.error || r.decodeError))
      throw Error("协议失败被标为完成");
    const partial = Boolean(r.timedOut || r.limited || r.partial);
    if (
      (record.status === "completed" && partial) ||
      (record.status === "partial" && !partial)
    )
      throw Error("协议完成状态与边界标记不一致");
  }
  if (Buffer.byteLength(JSON.stringify(record)) > 3 * 1024 * 1024)
    throw Error("协议执行记录超过3MiB");
}
