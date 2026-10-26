import { validateHeaderName, validateHeaderValue } from "node:http";
const plain = (x) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(x));
export const persistentHandshakeHeaders = new Set([
  "accept",
  "accept-language",
  "content-type",
  "cache-control",
  "pragma",
  "user-agent",
]);
function name(value) {
  if (typeof value !== "string" || value !== value.trim())
    throw Error("协议Header名称无效");
  validateHeaderName(value);
  const key = value.toLowerCase();
  if (
    [
      "host",
      "connection",
      "upgrade",
      "content-length",
      "transfer-encoding",
      "proxy-authorization",
      "__proto__",
      "constructor",
      "prototype",
    ].includes(key) ||
    key.startsWith("sec-websocket-")
  )
    throw Error("协议Header属于保留字段");
  return key;
}
export function protocolHeaders(input = {}) {
  if (
    !plain(input) ||
    Object.keys(input).length > 50 ||
    Buffer.byteLength(JSON.stringify(input)) > 8192
  )
    throw Error("协议Headers无效或超限");
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = name(key);
    if (Object.hasOwn(out, normalized) || typeof value !== "string")
      throw Error("协议Header重复或非文本");
    validateHeaderValue(key, value);
    out[normalized] = value;
  }
  return out;
}
export function normalizeHandshake(input, type) {
  if (input === undefined) return undefined;
  if (
    !["sse", "websocket"].includes(type) ||
    !plain(input) ||
    Object.keys(input).some((k) => !["headers", "requiredHeaders"].includes(k))
  )
    throw Error("协议握手定义无效");
  const headers = protocolHeaders(input.headers);
  if (Object.keys(headers).some((key) => !persistentHandshakeHeaders.has(key)))
    throw Error("认证或自定义Header必须在运行时提供");
  const required = input.requiredHeaders ?? [];
  if (!Array.isArray(required) || required.length > 50)
    throw Error("协议所需Header无效");
  const requiredHeaders = required.map(name);
  if (
    new Set(requiredHeaders).size !== requiredHeaders.length ||
    requiredHeaders.some((key) => Object.hasOwn(headers, key))
  )
    throw Error("协议所需Header重复或冲突");
  if (
    new Set([
      ...Object.keys(headers),
      ...requiredHeaders,
      ...(type === "sse" ? ["accept"] : []),
    ]).size > 50 ||
    Buffer.byteLength(JSON.stringify({ headers, requiredHeaders })) > 8192
  )
    throw Error("协议握手合并后超限");
  return { headers, requiredHeaders: requiredHeaders.sort() };
}
export function resolveHandshake(definition, runtimeHeaders) {
  const handshake = normalizeHandshake(definition.handshake, definition.type);
  const runtime = protocolHeaders(runtimeHeaders);
  for (const key of handshake?.requiredHeaders || [])
    if (!Object.hasOwn(runtime, key) || !runtime[key].trim())
      throw Error("缺少协议运行时Header: " + key);
  const merged = protocolHeaders({ ...handshake?.headers, ...runtime });
  return definition.type === "sse" ? sseHeaders(merged) : merged;
}
export function sseHeaders(input) {
  return protocolHeaders({
    accept: "text/event-stream",
    ...protocolHeaders(input),
  });
}
