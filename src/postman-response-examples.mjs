import { validateMockResponse } from "../public/response-example.js";
import { appendResponseExamples } from "./openapi-response-examples.mjs";
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const encoder = new TextEncoder();

// This bounded importer accepts enabled object rows, not raw-header parsing.
// Repeated active names cannot be represented by the canonical map: reject,
// never silently drop or combine.
function responseHeaders(value) {
  if (value === undefined || value === null || value === "") return {};
  if (!Array.isArray(value))
    throw Error("Postman响应头暂只支持header对象数组，不支持原始头字符串");
  const entries = [],
    names = new Set();
  for (const row of value) {
    if (
      !object(row) ||
      typeof row.key !== "string" ||
      typeof row.value !== "string" ||
      (row.disabled !== undefined && typeof row.disabled !== "boolean")
    )
      throw Error("Postman响应头须为key/value文本及可选disabled布尔值");
    if (row.disabled === true) continue;
    const name = row.key.toLowerCase();
    if (names.has(name))
      throw Error("Postman响应头名称大小写不敏感重复，不能无损导入");
    names.add(name);
    entries.push([name, row.value]);
  }
  return Object.fromEntries(entries);
}
export function importPostmanResponseExamples(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 1000)
    throw Error("Postman响应示例须为数组且最多1000项");
  let bytes = 0;
  return value.map((source) => {
    if (!object(source)) throw Error("Postman响应示例须为对象");
    if (
      source.name !== undefined &&
      (typeof source.name !== "string" || source.name.length > 8192)
    )
      throw Error("Postman响应示例名称无效或超过8192字符");
    const headers = responseHeaders(source.header);
    const example = {
      name: source.name,
      status: source.code ?? 200,
      body: source.body ?? "",
      // Preserve the old no-header default; do not sniff the body or invent a
      // Content-Type. Disabled rows are not active response headers.
      ...(Object.keys(headers).length ? { headers } : {}),
    };
    validateMockResponse(example, { allowInformational: true });
    bytes += encoder.encode(example.body).length;
    if (bytes > 8 * 1024 * 1024)
      throw Error("每个接口响应示例正文合计最多8MiB");
    // Use the existing textual/JSON export contract without rewriting raw body
    // bytes. Binary media is unsupported; XML here is only inert text.
    if (Object.hasOwn(headers, "content-type"))
      appendResponseExamples({}, [example]);
    return example;
  });
}
