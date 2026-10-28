import {
  hasQuerySerialization,
  validateQueryArrayRequest,
} from "./openapi-query-arrays.mjs";
const own = (o, k) => Object.hasOwn(o, k);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function dictionary(value, label) {
  if (!object(value)) throw Error(`${label} 必须是对象`);
  for (const key of Object.keys(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw Error("不允许的输入键");
  }
}
const textValue = (v) =>
  v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
function rowsOverride(rows, values, label, insensitive = false, form = false) {
  dictionary(values, label);
  const canonical = (key) => (insensitive ? key.toLowerCase() : key);
  const seen = new Set();
  for (const [key, value] of Object.entries(values)) {
    const normalized = canonical(key);
    if (seen.has(normalized)) throw Error(`${label} 输入键重复`);
    seen.add(normalized);
    const matches = (rows || []).filter(
      (row) => canonical(row.key || "") === normalized,
    );
    if (!matches.length) throw Error(`${label} 参数未定义: ${key}`);
    for (const row of matches) {
      if (form && (row.type === "file" || row.filename || row.requiresFile))
        throw Error("不支持临时覆盖文件字段");
      if (hasQuerySerialization(row) && !Array.isArray(value))
        throw Error("OpenAPI Query数组临时输入须为数组");
      row.value = textValue(value);
      row.enabled = true;
    }
  }
}
function authOverride(target, patch) {
  dictionary(patch, "auth");
  if (!object(target)) throw Error("接口未定义认证配置");
  for (const [key, value] of Object.entries(patch)) {
    if (!own(target, key)) throw Error(`认证字段未定义: ${key}`);
    if (key === "type" && value !== target[key])
      throw Error("不能改变认证类型");
    if (object(value)) authOverride(target[key], value);
    else {
      if (
        typeof value !== typeof target[key] ||
        Array.isArray(value) ||
        value === null
      )
        throw Error("认证字段类型不匹配");
      target[key] = value;
    }
  }
}
export function applyMCPInput(request, input) {
  const result = structuredClone(request);
  if (input === undefined) return result;
  dictionary(input, "input");
  const encoded = JSON.stringify(input, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value))
      throw Error("输入必须是有限 JSON 值");
    if (["undefined", "function", "symbol", "bigint"].includes(typeof value))
      throw Error("输入必须是 JSON 值");
    return value;
  });
  if (Buffer.byteLength(encoded) > 1024 * 1024)
    throw Error("临时输入超过 1 MiB");
  for (const key of Object.keys(input)) {
    if (!["query", "path", "headers", "cookies", "body", "auth"].includes(key))
      throw Error(`不支持的临时输入: ${key}`);
  }
  for (const key of ["query", "path", "headers", "cookies"]) {
    if (own(input, key))
      rowsOverride(result[key], input[key], key, key === "headers");
  }
  if (own(input, "body")) {
    if (["json", "msgpack"].includes(result.bodyType))
      result.body = JSON.stringify(input.body);
    else if (["urlencoded", "form-data"].includes(result.bodyType))
      rowsOverride(result.form, input.body, "body", false, true);
    else if (
      ["raw", "text", "plain", "xml", "html", "javascript"].includes(
        result.bodyType,
      ) &&
      typeof input.body === "string"
    )
      result.body = input.body;
    else throw Error("此请求体不支持该临时输入");
  }
  if (own(input, "auth")) authOverride(result.auth, input.auth);
  validateQueryArrayRequest(result);
  return result;
}
