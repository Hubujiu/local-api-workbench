const encoder = new TextEncoder();
const transportHeaders = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "trailer",
]);
const isolationHeaders = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-content-type-options",
  "cache-control",
  "set-cookie",
  "clear-site-data",
  "refresh",
]);
export function validateMockResponse(
  response,
  { allowInformational = false } = {},
) {
  const minimum = allowInformational ? 100 : 200;
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    !Number.isInteger(response.status) ||
    response.status < minimum ||
    response.status > 599
  )
    throw Error("响应状态须为" + minimum + "至599的整数");
  if (
    typeof response.body !== "string" ||
    !response.body.isWellFormed() ||
    encoder.encode(response.body).length > 8 * 1024 * 1024
  )
    throw Error("Mock响应体超过8MiB或文本格式无效");
  if (
    response.delayMs !== undefined &&
    (!Number.isInteger(response.delayMs) ||
      response.delayMs < 0 ||
      response.delayMs > 5000)
  )
    throw Error("Mock延迟须为0至5000ms");
  const headers = response.headers ?? {};
  if (
    typeof headers !== "object" ||
    Array.isArray(headers) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(headers))
  )
    throw Error("响应头须为JSON对象");
  const names = new Set();
  let bytes = 0;
  const entries = Object.entries(headers);
  if (entries.length > 100) throw Error("响应头最多100项");
  for (const [key, value] of entries) {
    const lower = key.toLowerCase();
    if (isolationHeaders.has(lower)) throw Error("Mock不可覆盖工作台隔离头");
    if (transportHeaders.has(lower)) throw Error("Mock不可覆盖传输控制头");
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
      key.length > 256 ||
      names.has(lower)
    )
      throw Error("响应头名称无效、重复或超过256字符");
    names.add(lower);
    if (
      typeof value !== "string" ||
      /[^\t\x20-\x7e\x80-\xff]/.test(value) ||
      value.length > 8192
    )
      throw Error("响应头值必须为有效HTTP文本，且不超过8KiB");
    bytes += key.length + value.length + 4;
    if (bytes > 65536) throw Error("响应头总大小超过64KiB");
  }
  return response;
}
export function editResponseExample(existing, values) {
  if (!existing || typeof existing !== "object" || Array.isArray(existing))
    throw Error("响应示例格式无效");
  const value = {
    ...existing,
    name: values.name,
    status: values.status,
    body: values.body,
    headers: values.headers,
    delayMs: values.delayMs,
  };
  if (typeof value.name !== "string") throw Error("响应示例名称无效");
  validateMockResponse(value, { allowInformational: true });
  return value;
}
