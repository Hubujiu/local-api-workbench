import { types } from "node:util";
import { createHash } from "node:crypto";

export const REDIRECT_BYTE_LIMIT = 8 * 1024 * 1024;
const failures = new WeakMap();
const reasons = new Set([
  "origin",
  "location",
  "retry-after",
  "hops",
  "loop",
  "response-budget",
  "header-limit",
  "transport",
  "cookie",
  "cancelled",
  "timeout",
]);
export function normalizeRedirect(value) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("无效的 redirect 策略");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        !["mode", "maxHops"].includes(key) ||
        !Object.hasOwn(descriptors[key], "value"),
    )
  )
    throw Error("无效的 redirect 策略字段");
  const mode = descriptors.mode?.value;
  const maxHops = descriptors.maxHops ? descriptors.maxHops.value : 5;
  if (
    mode !== "same-origin" ||
    !Number.isInteger(maxHops) ||
    maxHops < 1 ||
    maxHops > 5
  )
    throw Error("redirect 仅支持 same-origin，maxHops 必须为 1..5");
  return { mode, maxHops };
}
export function assertRedirectExportable(request) {
  if (normalizeRedirect(request?.redirect))
    throw Error("此导出格式不能保真表达 redirect 策略，请使用完整项目备份");
}
export function validateRedirectAdmission(r, headers) {
  if (!r.redirect) return;
  if (
    !["none", "basic", "bearer", "oauth2", "apiKey"].includes(r.auth.type) ||
    (r.auth.type === "apiKey" && r.auth.in === "query")
  )
    throw Error("redirect 暂不支持此认证方式");
  const forbidden = new Set([
    "host",
    "proxy-authorization",
    "connection",
    "upgrade",
    "expect",
    "transfer-encoding",
    "content-length",
    "trailer",
    "te",
    "cookie",
    "authorization",
    "set-cookie",
  ]);
  if (
    r.auth.type === "apiKey" &&
    forbidden.has(String(r.auth.key).toLowerCase())
  )
    throw Error("redirect 不允许控制字段 API Key");
  if (
    Object.keys(headers).some((key) =>
      [
        "connection",
        "upgrade",
        "expect",
        "transfer-encoding",
        "content-length",
        "trailer",
        "te",
      ].includes(key.toLowerCase()),
    )
  )
    throw Error("redirect 不允许手工连接或 framing 字段");
  if (
    Object.hasOwn(headers, "host") ||
    Object.hasOwn(headers, "proxy-authorization")
  )
    throw Error("redirect 不允许 Host 或 Proxy-Authorization 覆盖");
  if (
    headers.authorization &&
    !/^(Basic|Bearer)\s+\S/i.test(headers.authorization)
  )
    throw Error("redirect 不支持此 Authorization 方案");
}
export function redirectDecision(response, current, initialOrigin, method) {
  if (![301, 302, 303, 307, 308].includes(response.status)) return null;
  const rows = response.rawHeaders || [];
  const locations = [];
  for (let i = 0; i < rows.length; i += 2)
    if (String(rows[i]).toLowerCase() === "location")
      locations.push(String(rows[i + 1]));
  if (!locations.length) return null;
  if (locations.length !== 1) return { reason: "location" };
  const location = locations[0];
  if (
    !location ||
    Buffer.byteLength(location) > 8192 ||
    /[\x00-\x20\x7f\\]/.test(location)
  )
    return { reason: "location" };
  if (response.headers["retry-after"]) return { reason: "retry-after" };
  let target;
  try {
    target = new URL(location, current);
  } catch {
    return { reason: "location" };
  }
  if (!location.includes("#")) target.hash = current.hash;
  if (
    target.username ||
    target.password ||
    !["http:", "https:"].includes(target.protocol) ||
    target.origin !== initialOrigin
  )
    return { reason: "origin" };
  if (Buffer.byteLength(target.href) > 8192) return { reason: "location" };
  const dropBody =
    response.status === 303 ||
    ([301, 302].includes(response.status) && method === "POST");
  const nextMethod =
    response.status === 303
      ? method === "HEAD"
        ? "HEAD"
        : "GET"
      : dropBody
        ? "GET"
        : method;
  return { target, method: nextMethod, dropBody };
}
export function dropEntityHeaders(headers) {
  for (const key of Object.keys(headers))
    if (
      key.toLowerCase().startsWith("content-") ||
      ["transfer-encoding", "trailer", "expect", "digest"].includes(
        key.toLowerCase(),
      )
    )
      delete headers[key];
}
export function redirectStateKey(url, method, headers, body) {
  const wire = new URL(url);
  wire.hash = "";
  return createHash("sha256")
    .update(method)
    .update("\0")
    .update(wire.href)
    .update("\0")
    .update(JSON.stringify(Object.entries(headers).sort()))
    .update("\0")
    .update(body || "")
    .digest("hex");
}
export function httpRedirectFailure(
  response,
  reason,
  trace,
  attemptedUrl,
  requestStarted,
  responseComplete,
) {
  if (!reasons.has(reason)) throw TypeError("无效的 redirect 失败原因");
  const failure = Object.freeze({
    code:
      reason === "cancelled"
        ? "REQUEST_CANCELLED"
        : reason === "timeout"
          ? "REQUEST_TIMEOUT"
          : "HTTP_REDIRECT_FAILED",
    reason,
    phase: "http-redirect",
    retry_safe: false,
    responseComplete: !!responseComplete,
    attemptedUrl,
    requestStarted: !!requestStarted,
    trace: trace.map((x) => Object.freeze({ ...x })),
  });
  const error = Error("HTTP redirect failed: " + reason);
  if (response) response.redirectFailure = failure;
  failures.set(error, Object.freeze({ response, failure }));
  return error;
}
export function readHttpRedirectFailure(error) {
  return failures.get(error);
}
