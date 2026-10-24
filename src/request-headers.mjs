import { validateHeaderName, validateHeaderValue } from "node:http";
// Do not turn ambiguous framing/authentication fields into repeated wire fields.
const singleton = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "content-type",
  "authorization",
  "proxy-authorization",
  "connection",
  "upgrade",
  "expect",
  "trailer",
  "te",
  "user-agent",
  "referer",
  "from",
  "if-modified-since",
  "if-unmodified-since",
  "max-forwards",
]);
export function requestHeaderMap(rows = [], authType = "none") {
  if (!Array.isArray(rows)) throw Error("请求头必须为数组");
  const headers = Object.create(null);
  for (const row of rows) {
    if (row.enabled === false || !row.key) continue;
    const key = String(row.key).toLowerCase(),
      value = String(row.value ?? "");
    validateHeaderName(key);
    validateHeaderValue(key, value);
    if (Object.hasOwn(headers, key)) {
      if (
        singleton.has(key) ||
        (authType === "aws" &&
          [
            "x-amz-date",
            "x-amz-security-token",
            "x-amz-content-sha256",
            "cookie",
            "set-cookie",
          ].includes(key))
      )
        throw Error("不允许重复的控制/单值请求头: " + key);
      if (authType === "edgegrid")
        throw Error("此签名认证的重复请求头尚未验证，请明确合并值");
      if (Array.isArray(headers[key])) headers[key].push(value);
      else headers[key] = [headers[key], value];
    } else headers[key] = value;
  }
  return headers;
}
