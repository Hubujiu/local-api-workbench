import { normalizeRequest, interpolate } from "./core.mjs";
export function scriptHTTPRequest(input, variables = {}) {
  const config = typeof input === "string" ? { url: input } : input;
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw Error("脚本HTTP请求格式无效");
  for (const key of Object.keys(config))
    if (
      !["url", "method", "header", "headers", "body", "timeout"].includes(key)
    )
      throw Error("脚本HTTP暂不支持选项: " + key);
  if (typeof config.url !== "string") throw Error("脚本HTTP需要字符串URL");
  const headers = config.header ?? config.headers ?? {};
  if (!headers || typeof headers !== "object")
    throw Error("脚本HTTP请求头格式无效");
  if (
    Array.isArray(headers) &&
    headers.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        typeof row.key !== "string" ||
        !row.key,
    )
  )
    throw Error("脚本HTTP请求头字段无效");
  const rows = Array.isArray(headers)
    ? headers.map((row) => ({
        key: String(row.key),
        value: String(row.value ?? ""),
        enabled: row.disabled !== true,
      }))
    : Object.entries(headers).map(([key, value]) => ({
        key,
        value: String(value),
        enabled: true,
      }));
  if (rows.length > 100) throw Error("脚本HTTP请求头最多100项");
  let bodyType = "none",
    body = "",
    form = [];
  if (config.body !== undefined) {
    if (typeof config.body === "string") {
      bodyType = "raw";
      body = config.body;
    } else if (
      config.body?.mode === "raw" &&
      typeof config.body.raw === "string"
    ) {
      bodyType = "raw";
      body = config.body.raw;
    } else if (
      config.body?.mode === "urlencoded" &&
      Array.isArray(config.body.urlencoded)
    ) {
      if (config.body.urlencoded.length > 100)
        throw Error("脚本HTTP表单最多100项");
      bodyType = "urlencoded";
      form = config.body.urlencoded.map((row) => ({
        key: String(row.key),
        value: String(row.value ?? ""),
        enabled: row.disabled !== true,
      }));
    } else throw Error("脚本HTTP Body暂支持raw或urlencoded，不读取文件");
  }
  const request = interpolate(
    normalizeRequest({
      url: config.url,
      method: config.method || "GET",
      headers: rows,
      bodyType,
      body,
      form,
      timeout: Math.min(1500, Math.max(100, Number(config.timeout) || 1500)),
    }),
    variables,
  );
  if (!["http:", "https:"].includes(new URL(request.url).protocol))
    throw Error("脚本HTTP仅支持HTTP/HTTPS");
  if (Buffer.byteLength(JSON.stringify(request)) > 65536)
    throw Error("脚本HTTP请求超过64KiB");
  return request;
}
