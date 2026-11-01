import { validateTCPDelimiterEvidence } from "./tcp-delimiter.mjs";

export const WIRE_SCRIPT_CONTEXT_BYTES = 2 * 1024 * 1024;
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const dataKeys = (value, allowed) =>
  plain(value) &&
  Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === "string" &&
      allowed.includes(key) &&
      descriptor.enumerable &&
      Object.hasOwn(descriptor, "value")
    );
  });
const fail = () => {
  throw Error("协议脚本上下文无效或超过2MiB/结构上限");
};
const pick = (value, allowed) => {
  if (!plain(value)) fail();
  const result = {};
  for (const key of allowed) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field) continue;
    if (!field.enumerable || !Object.hasOwn(field, "value")) fail();
    if (field.value !== undefined) result[key] = field.value;
  }
  return result;
};
export function normalizeProtocolScripts(value) {
  if (value === undefined) return undefined;
  if (
    !dataKeys(value, ["version", "before", "after"]) ||
    value.version !== 1 ||
    ["before", "after"].some(
      (phase) =>
        value[phase] !== undefined &&
        (typeof value[phase] !== "string" || value[phase].length > 100000),
    )
  )
    throw Error("协议脚本需要version:1与最多100000字符的before/after源码");
  return { version: 1, before: value.before ?? "", after: value.after ?? "" };
}

const resultKeys = {
  tcp: [
    "body",
    "base64",
    "size",
    "timedOut",
    "partial",
    "decoded",
    "decodeError",
    "framing",
    "error",
  ],
  websocket: [
    "messages",
    "protocol",
    "timedOut",
    "limited",
    "closeCode",
    "closeReason",
    "error",
  ],
  sse: ["status", "events", "timedOut", "limited", "cancelled", "error"],
};
const requestKeys = {
  tcp: [
    "host",
    "port",
    "duration",
    "completion",
    "delimiterHex",
    "templateMode",
    "message",
  ],
  websocket: [
    "url",
    "duration",
    "maxMessages",
    "templateMode",
    "message",
    "sendEmptyMessage",
  ],
  sse: ["url", "method", "body", "duration", "maxEvents", "templateMode"],
};

// Copy only native data, never the complete definition or credentialed request.
export function wireScriptContext(protocol, phase, result) {
  const envelope = pick(protocol, [
      "definition",
      "message",
      "duration",
      "maxMessages",
      "maxEvents",
    ]),
    definition = pick(envelope.definition, [
      "type",
      "url",
      "port",
      "completion",
      "delimiterHex",
      "templateMode",
      "sendEmptyMessage",
      "method",
      "body",
    ]),
    type = definition.type;
  if (!Object.hasOwn(requestKeys, type)) fail();
  const request = {
    ...pick(definition, requestKeys[type]),
    ...pick(envelope, requestKeys[type]),
  };
  if (type === "tcp") {
    request.host = definition.url;
    request.completion = definition.completion ?? "end";
  } else if (type === "sse") request.method = definition.method ?? "GET";
  const native =
    result === undefined
      ? undefined
      : pick(result, ["status", "durationMs", "result"]);
  return normalizeWireScriptContext({
    protocol: type,
    phase,
    request,
    ...(native === undefined
      ? {}
      : {
          result: { ...native, result: pick(native.result, resultKeys[type]) },
        }),
  });
}

// One budget covers the whole context, including key bytes and both phases'
// request/result views. Check descriptors before serialization can invoke code.
export function normalizeWireScriptContext(value) {
  let nodes = 0;
  const safeJSON = (item, depth = 0) => {
    if (depth > 64 || ++nodes > 20000) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return item.isWellFormed();
    if (Array.isArray(item)) {
      if (
        Object.getPrototypeOf(item) !== Array.prototype ||
        Reflect.ownKeys(item).length !== item.length + 1
      )
        return false;
      for (let index = 0; index < item.length; index++) {
        const field = Object.getOwnPropertyDescriptor(item, String(index));
        if (
          !field?.enumerable ||
          !Object.hasOwn(field, "value") ||
          !safeJSON(field.value, depth + 1)
        )
          return false;
      }
      return true;
    }
    if (!plain(item) || !dataKeys(item, Object.keys(item))) return false;
    return Object.entries(item).every(
      ([key, child]) =>
        !["__proto__", "prototype", "constructor"].includes(key) &&
        safeJSON(child, depth + 1),
    );
  };
  if (!safeJSON(value)) fail();
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > WIRE_SCRIPT_CONTEXT_BYTES) fail();
  if (
    !dataKeys(value, ["protocol", "phase", "request", "result"]) ||
    !Object.hasOwn(requestKeys, value.protocol) ||
    !["before", "after"].includes(value.phase)
  )
    fail();
  const type = value.protocol,
    request = value.request;
  const text = (item, max = WIRE_SCRIPT_CONTEXT_BYTES) =>
    typeof item === "string" && Buffer.byteLength(item) <= max;
  const integer = (item, min, max) =>
    Number.isInteger(item) && item >= min && item <= max;
  const optionalBoolean = (item, key) =>
    item[key] === undefined || typeof item[key] === "boolean";
  if (
    !dataKeys(request, requestKeys[type]) ||
    !integer(request.duration, 100, 30000) ||
    (request.templateMode !== undefined &&
      !["literal", "variables"].includes(request.templateMode))
  )
    fail();
  if (type === "tcp") {
    if (
      !text(request.host, 2048) ||
      !request.host ||
      !integer(request.port, 1, 65535) ||
      !["end", "first-data", "delimiter"].includes(request.completion)
    )
      fail();
    if (
      request.completion === "delimiter"
        ? typeof request.delimiterHex !== "string" ||
          !/^(?:[0-9a-f]{2}){1,64}$/.test(request.delimiterHex)
        : request.delimiterHex !== undefined
    )
      fail();
  } else if (!text(request.url, 8192) || !request.url) fail();
  if (type === "sse") {
    if (
      !["GET", "POST"].includes(request.method) ||
      !integer(request.maxEvents, 1, 100) ||
      (request.body !== undefined &&
        (request.method !== "POST" || !text(request.body, 65536))) ||
      (request.templateMode !== undefined &&
        (request.method !== "POST" || request.body === undefined))
    )
      fail();
  } else if (
    !(text(request.message, 1048576) || plain(request.message)) ||
    (request.templateMode !== undefined && typeof request.message !== "string")
  )
    fail();
  if (
    type === "websocket" &&
    (!integer(request.maxMessages, 1, 100) ||
      !optionalBoolean(request, "sendEmptyMessage"))
  )
    fail();
  if (value.phase === "before") {
    if (Object.hasOwn(value, "result")) fail();
  } else {
    const outer = value.result;
    if (
      !dataKeys(outer, ["status", "durationMs", "result"]) ||
      !["completed", "partial", "failed", "cancelled"].includes(outer.status) ||
      !Number.isFinite(outer.durationMs) ||
      outer.durationMs < 0 ||
      !dataKeys(outer.result, resultKeys[type])
    )
      fail();
    const result = outer.result;
    if (Object.hasOwn(result, "error")) {
      if (
        Object.keys(result).length !== 1 ||
        !["failed", "cancelled"].includes(outer.status) ||
        !text(result.error, 4096)
      )
        fail();
    } else if (type === "tcp") {
      if (
        !text(result.body) ||
        !text(result.base64, 1400000) ||
        !integer(result.size, 0, 1048576) ||
        typeof result.timedOut !== "boolean" ||
        typeof result.partial !== "boolean" ||
        (result.decodeError !== undefined && !text(result.decodeError, 4096))
      )
        fail();
      const bytes = Buffer.from(result.base64, "base64");
      if (
        bytes.length !== result.size ||
        bytes.toString("base64") !== result.base64 ||
        bytes.toString("utf8") !== result.body
      )
        fail();
      if (request.completion === "delimiter")
        validateTCPDelimiterEvidence(request, result);
      else if (result.framing !== undefined) fail();
    } else if (type === "websocket") {
      if (
        !Array.isArray(result.messages) ||
        result.messages.length > 100 ||
        !text(result.protocol, 2048) ||
        typeof result.timedOut !== "boolean" ||
        typeof result.limited !== "boolean" ||
        (result.closeCode !== undefined &&
          !integer(result.closeCode, 0, 65535)) ||
        (result.closeReason !== undefined && !text(result.closeReason, 4096))
      )
        fail();
      for (const message of result.messages) {
        if (
          !dataKeys(message, ["data", "encoding", "receivedAt"]) ||
          !text(message.data) ||
          !["utf8", "base64"].includes(message.encoding) ||
          !text(message.receivedAt, 100)
        )
          fail();
        if (
          message.encoding === "base64" &&
          Buffer.from(message.data, "base64").toString("base64") !==
            message.data
        )
          fail();
      }
    } else {
      if (
        !integer(result.status, 0, 599) ||
        !Array.isArray(result.events) ||
        result.events.length > 100 ||
        !["timedOut", "limited", "cancelled"].every((key) =>
          optionalBoolean(result, key),
        )
      )
        fail();
      for (const event of result.events)
        if (
          !dataKeys(event, ["event", "id", "data", "retry", "receivedAt"]) ||
          !["event", "id", "data"].every((key) => text(event[key])) ||
          !text(event.receivedAt, 100) ||
          (event.retry !== undefined &&
            (!Number.isSafeInteger(event.retry) || event.retry < 0))
        )
          fail();
    }
  }
  return JSON.parse(json);
}

function installWireScriptContext({ context, pm, apt, request }) {
  const freeze = (value) => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  const view = freeze(context);
  const unavailable = () => {
    throw Error("协议脚本不支持HTTP请求/响应修改或附加网络调用");
  };
  const allowed = [
    "variables",
    "environment",
    "globals",
    "test",
    "expect",
    "info",
    "iterationData",
    "setVar",
    "getVar",
  ];
  for (const api of [pm, apt]) {
    for (const key of Object.keys(api))
      if (!allowed.includes(key))
        api[key] = ["request", "response", "cookies"].includes(key)
          ? undefined
          : unavailable;
    api.info = Object.freeze({
      ...api.info,
      protocol: context.protocol,
      eventName: context.phase === "before" ? "prerequest" : "test",
    });
    Object.defineProperty(api, "wire", { value: view, enumerable: true });
    Object.freeze(api);
  }
  freeze(request);
  Object.defineProperty(globalThis, "wire", { value: view, enumerable: true });
}
export const wireScriptContextSource = installWireScriptContext.toString();

export function validateWireScriptBinding(input, requestLimit) {
  if (
    !dataKeys(input, [
      "allowNetwork",
      "executionContext",
      "variables",
      "scopes",
      "localVariables",
      "functions",
      "request",
      "responseOriginals",
    ]) ||
    input.allowNetwork ||
    requestLimit !== 0 ||
    input.responseOriginals != null ||
    !dataKeys(input.request || {}, ["id", "name"])
  )
    throw Error("协议脚本不能绑定HTTP网络、方言、响应或其他能力");
}

// Only inspect executable step containers, never arbitrary business JSON.
export function validatePlanProtocolScripts(
  steps,
  depth = 0,
  budget = { nodes: 0 },
) {
  if (!Array.isArray(steps) || depth > 32)
    throw Error("协议脚本计划步骤图无效");
  for (const step of steps) {
    if (!plain(step) || ++budget.nodes > 10000)
      throw Error("协议脚本计划步骤图无效");
    const field = Object.getOwnPropertyDescriptor(step, "protocolScripts");
    if (field) {
      if (step.type !== "protocol")
        throw Error("protocolScripts仅可用于协议计划步骤");
      if (!field.enumerable || !Object.hasOwn(field, "value"))
        throw Error("protocolScripts必须是普通JSON数据字段");
      normalizeProtocolScripts(field.value);
    }
    if (step.type === "repeat")
      validatePlanProtocolScripts(step.steps, depth + 1, budget);
  }
}

export function rejectHTTPProtocolScripts(request) {
  if (request && Object.hasOwn(request, "protocolScripts"))
    throw Error("HTTP定义不能表达protocolScripts；请使用协议计划或项目备份");
}
