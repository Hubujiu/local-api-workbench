import { urlQueryTools } from "./script-url-query.mjs";

// OpenAPI describes logical parameters, not an exact raw URI byte stream.
export function openAPIURLQuery(request) {
  const parts = urlQueryTools.splitURL(request.url);
  const pathURL = parts.at < 0 ? parts.base : parts.base.slice(0, parts.at);
  const query = [];
  if (Buffer.byteLength(parts.query, "utf8") > 65536)
    throw Error("OpenAPI URL Query超过64KiB");
  if (/{{[^{}]*}}/.test(parts.query))
    throw Error(
      "OpenAPI URL Query含未解析变量，请使用项目备份或环境解析后的cURL",
    );
  if (parts.query) {
    const rows = urlQueryTools.splitQuery(parts.query);
    if (rows.length > 1000) throw Error("OpenAPI URL Query最多1000项");
    for (const row of rows) {
      if (!row) continue;
      const at = urlQueryTools.pairBoundary(row);
      if (at < 0)
        throw Error("OpenAPI不能无损表达无等号URL Query，请使用cURL或项目备份");
      let key, value;
      try {
        key = urlQueryTools.decodeComponent(row.slice(0, at));
        value = urlQueryTools.decodeComponent(row.slice(at + 1));
      } catch {
        throw Error("OpenAPI URL Query编码无效");
      }
      if (!key) throw Error("OpenAPI URL Query名称不能为空");
      if (/{{[^{}]*}}/.test(key) || /{{[^{}]*}}/.test(value))
        throw Error(
          "OpenAPI URL Query解码后含模板字面量，请使用cURL或项目备份",
        );
      query.push({
        key,
        value,
        enabled: true,
        schema: { type: "string" },
        ...(value === "" ? { allowEmptyValue: true } : {}),
      });
    }
  }
  if (!Array.isArray(request.query ?? []))
    throw Error("OpenAPI Query参数表无效");
  for (const row of request.query || []) query.push(row);
  const names = new Set();
  for (const row of query) {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw Error("OpenAPI Query参数项无效");
    if (row.enabled === false || !row.key) continue;
    if (typeof row.key !== "string") throw Error("OpenAPI Query名称必须是文本");
    if (names.has(row.key))
      throw Error("OpenAPI Query名称重复，请使用cURL或项目备份");
    names.add(row.key);
  }
  return { pathURL, query };
}

export function openAPIEmptyQueryValue(value) {
  if (value === undefined) return {};
  if (typeof value !== "boolean")
    throw Error("OpenAPI Query allowEmptyValue必须为布尔值");
  return { allowEmptyValue: value };
}
