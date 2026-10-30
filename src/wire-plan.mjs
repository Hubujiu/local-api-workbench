import { planLeaves, activePlanLeaves } from "./plan-repeat.mjs";
import { resolveHandshake } from "./protocol-handshake.mjs";
import { validateProtocolTemplate } from "./protocol-text-templates.mjs";
import { protocolRequestOptions } from "./protocol-request-options.mjs";
import { normalizeProtocol } from "./protocol-definitions.mjs";
import { protocolPayload } from "./protocol-payload.mjs";
import { websocketConfiguration } from "./websocket-client.mjs";
import { captureSSE, exchangeTCP, exchangeWebSocket } from "./protocols.mjs";
import { jsonPathSegments } from "./json-path.mjs";
import { validateHeaderName, validateHeaderValue } from "node:http";
const plain = (x) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(x));
const statuses = ["completed", "partial", "failed"];
function rules(step) {
  const extract = step.extract ?? [],
    assertions = step.assertions ?? [];
  if (
    !Array.isArray(extract) ||
    extract.length > 100 ||
    !Array.isArray(assertions) ||
    assertions.length > 100
  )
    throw Error("协议计划提取和断言最多100项");
  for (const e of extract) {
    if (
      !plain(e) ||
      Object.keys(e).some((k) => !["name", "path", "scope"].includes(k)) ||
      typeof e.name !== "string" ||
      !e.name.trim() ||
      e.name.length > 100 ||
      ["__proto__", "constructor", "prototype"].includes(e.name) ||
      typeof e.path !== "string" ||
      e.path.length > 1000 ||
      (e.scope !== undefined &&
        !["runtime", "environment", "global"].includes(e.scope))
    )
      throw Error("协议计划提取无效");
    if (
      jsonPathSegments(e.path).some((k) =>
        ["__proto__", "constructor", "prototype"].includes(k),
      )
    )
      throw Error("协议计划禁止的提取路径");
  }
  for (const a of assertions) {
    if (
      !plain(a) ||
      Object.keys(a).some((k) => !["target", "op", "value"].includes(k)) ||
      typeof a.target !== "string" ||
      a.target.length > 1000 ||
      !["eq", "neq", "contains", "exists", "lt", "gt"].includes(a.op) ||
      !(
        a.target === "status" ||
        a.target === "duration" ||
        a.target.startsWith("$")
      )
    )
      throw Error("协议计划断言无效");
    if (a.target.startsWith("$")) jsonPathSegments(a.target);
  }
  return {
    extract: structuredClone(extract),
    assertions: structuredClone(assertions),
  };
}
function template(value) {
  let nodes = 0;
  const visit = (v, depth) => {
    if (++nodes > 10000 || depth > 32) throw Error("协议消息模板结构超限");
    if (
      v === null ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v))
    )
      return;
    if (typeof v === "string" && v.isWellFormed()) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (
      !plain(v) ||
      Object.keys(v).some((k) =>
        ["__proto__", "constructor", "prototype"].includes(k),
      )
    )
      throw Error("协议消息模板无效");
    for (const x of Object.values(v)) visit(x, depth + 1);
  };
  if (typeof value !== "string" && !plain(value))
    throw Error("协议消息模板须为文本或编码对象");
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024)
    throw Error("协议消息模板超过1MiB");
  if (!JSON.stringify(value).includes("{{")) protocolPayload(value);
  return structuredClone(value);
}
export function snapshotWireStep(step) {
  if (
    !plain(step) ||
    Object.keys(step).some(
      (k) =>
        ![
          "id",
          "name",
          "enabled",
          "type",
          "protocol",
          "extract",
          "assertions",
          "expectedStatus",
        ].includes(k),
    ) ||
    !plain(step.protocol) ||
    Object.keys(step.protocol).some(
      (k) =>
        ![
          "definition",
          "message",
          "duration",
          "maxEvents",
          "maxMessages",
        ].includes(k),
    )
  )
    throw Error("协议计划仅保存冻结定义和消息，不保存凭据或脚本");
  const { message: savedMessage, ...rawDefinition } =
    step.protocol.definition || {};
  const definition = normalizeProtocol(rawDefinition);
  const duration = step.protocol.duration ?? definition.duration ?? 3000;
  if (!Number.isInteger(duration) || duration < 100 || duration > 30000)
    throw Error("协议计划超时须为100至30000毫秒");
  const protocol = { definition, duration };
  if (definition.type === "sse") {
    if (
      step.protocol.message !== undefined ||
      step.protocol.maxMessages !== undefined
    )
      throw Error("SSE 计划不支持发送消息");
    protocol.maxEvents = step.protocol.maxEvents ?? 20;
  } else {
    const selectedMessage =
      step.protocol.message !== undefined
        ? step.protocol.message
        : (savedMessage ?? "");
    validateProtocolTemplate(definition, selectedMessage);
    protocolRequestOptions({ ...definition, message: selectedMessage });
    protocol.message =
      definition.templateMode === undefined
        ? template(selectedMessage)
        : selectedMessage;
    if (step.protocol.maxEvents !== undefined)
      throw Error("非 SSE 计划不能设置事件限制");
    if (definition.type === "websocket")
      protocol.maxMessages = step.protocol.maxMessages ?? 20;
    else if (step.protocol.maxMessages !== undefined)
      throw Error("TCP 计划不能设置WebSocket消息限制");
  }
  for (const key of ["maxEvents", "maxMessages"])
    if (
      protocol[key] !== undefined &&
      (!Number.isInteger(protocol[key]) ||
        protocol[key] < 1 ||
        protocol[key] > 100)
    )
      throw Error("协议计划消息限制须为1至100");
  const expectedStatus = step.expectedStatus ?? "completed";
  if (!statuses.includes(expectedStatus)) throw Error("协议计划预期状态无效");
  return {
    ...structuredClone(step),
    type: "protocol",
    protocol,
    expectedStatus,
    ...rules(step),
  };
}
export function freezeWireStep(project, step) {
  if (!step.protocol?.definitionId) return step;
  if (step.protocol.definition) throw Error("协议计划不能同时提供定义与引用");
  const definition = (project.protocols || []).find(
    (x) => x.id === step.protocol.definitionId,
  );
  if (!definition) throw Error("项目协议定义不存在");
  const { definitionId, ...rest } = step.protocol;
  return {
    ...step,
    protocol: { ...rest, definition: structuredClone(definition) },
  };
}
function headers(input = {}) {
  if (
    !plain(input) ||
    Object.keys(input).length > 50 ||
    Buffer.byteLength(JSON.stringify(input)) > 8192
  )
    throw Error("协议临时 Headers 无效或超限");
  const names = new Set();
  for (const [key, value] of Object.entries(input)) {
    const name = key.toLowerCase();
    validateHeaderName(key);
    if (typeof value !== "string") throw Error("协议 Header 必须为文本");
    validateHeaderValue(key, value);
    if (
      names.has(name) ||
      [
        "host",
        "connection",
        "upgrade",
        "content-length",
        "transfer-encoding",
        "proxy-authorization",
      ].includes(name)
    )
      throw Error("协议 Header 重复或属于保留字段");
    names.add(name);
  }
  return input;
}
export function wirePlanCredentials(plan, input = {}) {
  if (
    !plain(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024
  )
    throw Error("协议临时凭据映射无效");
  const leaves = planLeaves(plan.steps);
  for (const step of leaves)
    if (step.type === "protocol") snapshotWireStep(step);
  const bindings = new Map();
  for (const [stepId, value] of Object.entries(input)) {
    const matches = leaves.filter((step) => step.id === stepId);
    if (
      matches.length !== 1 ||
      matches[0].type !== "protocol" ||
      ["__proto__", "constructor", "prototype"].includes(stepId) ||
      !plain(value) ||
      Object.keys(value).some(
        (k) => !["headers", "tls", "protocols"].includes(k),
      )
    )
      throw Error("协议临时凭据步骤无效，不能覆盖端点");
    const definition = matches[0].protocol.definition;
    if (definition.type === "tcp" && Object.keys(value).length)
      throw Error("TCP 计划暂不支持这些认证配置");
    if (definition.type === "sse") {
      if (value.tls !== undefined || value.protocols !== undefined)
        throw Error("SSE 临时凭据仅支持 Headers");
      headers(value.headers);
    }
    if (definition.type === "websocket")
      websocketConfiguration({ url: definition.url, ...value });
    bindings.set(stepId, structuredClone(value));
  }
  for (const step of activePlanLeaves(plan.steps))
    if (step.type === "protocol" && step.protocol.definition.type !== "tcp")
      resolveHandshake(
        step.protocol.definition,
        bindings.get(step.id)?.headers,
      );
  return bindings;
}
export async function executeWireFlow(input, signal) {
  const started = performance.now(),
    type = input.definition.type;
  try {
    signal?.throwIfAborted();
    if (input.definition.templateMode === "variables")
      throw Error("协议模板须由项目执行入口解析");
    const request = {
      ...protocolRequestOptions(input.definition),
      ...input,
      ...(input.definition.templateMode !== undefined
        ? { templateMode: input.definition.templateMode }
        : {}),
      ...(type === "tcp"
        ? { host: input.definition.url, port: input.definition.port }
        : { url: input.definition.url }),
    };
    if (type !== "tcp")
      request.headers = resolveHandshake(input.definition, input.headers);
    if (type !== "sse") protocolPayload(request.message);
    const fn = {
      tcp: exchangeTCP,
      websocket: exchangeWebSocket,
      sse: captureSSE,
    }[type];
    if (!fn) throw Error("未知协议");
    const result = await fn(request, signal);
    const status =
      result.partial || result.timedOut || result.limited
        ? "partial"
        : result.decodeError
          ? "failed"
          : "completed";
    return {
      type,
      status,
      durationMs: Math.max(0, performance.now() - started),
      result,
    };
  } catch (error) {
    return {
      type,
      status: signal?.aborted ? "cancelled" : "failed",
      durationMs: Math.max(0, performance.now() - started),
      result: { error: String(error.message || error) },
    };
  }
}
