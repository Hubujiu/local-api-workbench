// Restricted OAS3 form/explode object parameters. Never infer from JSON text.
const own = (o, k) => Object.hasOwn(o, k);
const fail = (detail) => {
  throw Error("OpenAPI Query对象: " + detail);
};
const plain = (o) =>
  o !== null &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(o)) &&
  Reflect.ownKeys(o).every(
    (k) =>
      typeof k === "string" &&
      Object.getOwnPropertyDescriptor(o, k)?.enumerable &&
      own(Object.getOwnPropertyDescriptor(o, k), "value"),
  );
const LIMIT = 65536;
const types = ["string", "number", "integer", "boolean"];
const forbidden = [
  "$ref",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "items",
  "prefixItems",
  "patternProperties",
  "dependentSchemas",
  "unevaluatedProperties",
];
export const hasQueryObjectSerialization = (row) =>
  row && own(row, "queryObjectSerialization");
const keyOK = (key) =>
  typeof key === "string" &&
  /^[A-Za-z_][A-Za-z0-9_.~-]{0,127}$/.test(key) &&
  !["__proto__", "prototype", "constructor"].includes(key);
function descriptor(row) {
  const d = Object.getOwnPropertyDescriptor(row, "queryObjectSerialization"),
    m = d?.value;
  if (
    !d?.enumerable ||
    !own(d, "value") ||
    !plain(m) ||
    Object.keys(m).length !== 3 ||
    m.version !== 1 ||
    m.style !== "form" ||
    m.explode !== true
  )
    fail("序列化标记无效");
  if (!keyOK(row.key)) fail("参数名须为静态ASCII安全标识");
  if (
    ["querySerialization", "reservedQuerySerialization"].some((k) =>
      own(row, k),
    )
  )
    fail("不能混用序列化标记");
  const s = row.schema;
  if (
    !plain(s) ||
    s.type !== "object" ||
    s.nullable === true ||
    forbidden.some((k) => own(s, k)) ||
    !plain(s.properties) ||
    s.additionalProperties !== false ||
    !Object.keys(s.properties).length ||
    Object.keys(s.properties).length > 1000
  )
    fail("仅支持封闭的明确扁平对象Schema");
  for (const [key, child] of Object.entries(s.properties)) {
    if (!keyOK(key)) fail("属性名须为静态ASCII安全标识");
    if (
      !plain(child) ||
      !types.includes(child.type) ||
      child.nullable === true ||
      forbidden.some((k) => own(child, k))
    )
      fail("属性须为明确非null标量Schema");
  }
  return m;
}
export function parseQueryObject(row, value = row.value) {
  descriptor(row);
  if (typeof value !== "string" || Buffer.byteLength(value) > LIMIT)
    fail("值须为64KiB以内JSON对象文本");
  let result;
  try {
    result = JSON.parse(value);
  } catch {
    fail("JSON对象文本无效");
  }
  if (
    !plain(result) ||
    !Object.keys(result).length ||
    Object.keys(result).length > 1000
  )
    fail("值须为非空扁平对象");
  for (const [key, item] of Object.entries(result)) {
    if (!keyOK(key) || !own(row.schema.properties, key))
      fail("值含未声明或不安全属性");
    const type = row.schema.properties[key].type;
    if (type === "integer" ? !Number.isSafeInteger(item) : typeof item !== type)
      fail("属性值类型与Schema不一致");
    if (
      typeof item === "number" &&
      (!Number.isFinite(item) ||
        (Number.isInteger(item) && !Number.isSafeInteger(item)))
    )
      fail("数值须有限且安全");
    if (
      item === "" ||
      (typeof item === "string" && /[\x00-\x1f\x7f]/.test(item))
    )
      fail("首片不支持空字符串或控制字符");
    encode(item);
  }
  return result;
}
function encode(value) {
  try {
    return encodeURIComponent(String(value)).replace(
      /[!'()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
  } catch {
    fail("无效Unicode");
  }
}
export function encodeQueryObject(row) {
  const pairs = Object.entries(parseQueryObject(row)).map(
    ([k, v]) => encode(k) + "=" + encode(v),
  );
  if (Buffer.byteLength(pairs.join("&")) > LIMIT) fail("编码后超过64KiB");
  return pairs;
}
export function validateQueryObjectRequest(request) {
  for (const group of ["query", "headers", "cookies", "path", "form"]) {
    if (request[group] !== undefined && !Array.isArray(request[group]))
      fail("参数须为数组");
    if (
      group !== "query" &&
      (request[group] || []).some(hasQueryObjectSerialization)
    )
      fail("标记仅适用于Query");
  }
  const marked = (request.query || []).filter(hasQueryObjectSerialization);
  if (!marked.length) return;
  if (request.scriptURLMode === "sdk" || request.scriptURLRuntime !== undefined)
    fail("尚不支持SDK URL模式");
  if (request.queryAddEqual === false) fail("首片要求保留等号");
  if (
    request.auth?.type !== undefined &&
    !["none", "basic", "bearer"].includes(request.auth.type)
  )
    fail("首片仅支持none/basic/bearer认证");
  if (
    String(request.url || "")
      .split("#", 1)[0]
      .includes("?")
  )
    fail("首片不支持URL内原始Query");
  const names = new Map(),
    logical = new Set();
  let size = 0;
  for (const row of request.query || []) {
    const object = hasQueryObjectSerialization(row);
    const pairs = object ? encodeQueryObject(row) : [];
    if (row.enabled === false) continue;
    // Outer identities must also remain unique for full-object MCP replacement.
    if (logical.has(row.key)) fail("参数身份重复");
    logical.add(row.key);
    const keys = object
      ? Object.keys(parseQueryObject(row))
      : [String(row.key || "")];
    for (const key of keys) {
      if (names.has(key) && (object || names.get(key)))
        fail("展开后参数名冲突: " + key);
      names.set(key, object);
    }
    size += pairs.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0);
  }
  if (size > LIMIT) fail("对象Query编码总量超过64KiB");
}
export function importOpenAPIQueryObject(
  parameter,
  { oas3 = false, swagger = false } = {},
) {
  if (
    !oas3 ||
    swagger ||
    (parameter.style !== undefined && parameter.style !== "form") ||
    (parameter.explode !== undefined && parameter.explode !== true) ||
    (parameter.allowReserved !== undefined &&
      parameter.allowReserved !== false) ||
    own(parameter, "content") ||
    own(parameter, "collectionFormat") ||
    parameter.allowEmptyValue === true
  )
    fail("首片仅支持OAS3 form/explode=true且allowReserved=false");
  if (
    parameter.allowEmptyValue !== undefined &&
    typeof parameter.allowEmptyValue !== "boolean"
  )
    fail("allowEmptyValue须为布尔值");
  if (own(parameter, "example") && own(parameter, "examples"))
    fail("example和examples不能同时提供");
  let value;
  if (own(parameter, "example")) value = parameter.example;
  else if (own(parameter, "examples")) {
    if (
      !plain(parameter.examples) ||
      Object.keys(parameter.examples).length !== 1
    )
      fail("examples须有一个明确值");
    const e = Object.values(parameter.examples)[0];
    if (
      !plain(e) ||
      !own(e, "value") ||
      own(e, "$ref") ||
      own(e, "externalValue")
    )
      fail("examples须为内联value");
    value = e.value;
  } else if (own(parameter.schema, "default")) value = parameter.schema.default;
  else value = parameter.schema.example;
  if (!plain(value)) fail("须提供明确非空对象example/default");
  // Validate before JSON serialization can erase unsupported values.
  for (const v of Object.values(value))
    if (
      !["string", "number", "boolean"].includes(typeof v) ||
      (typeof v === "number" &&
        (!Number.isFinite(v) ||
          (Number.isInteger(v) && !Number.isSafeInteger(v))))
    )
      fail("输入须为安全primitive值");
  const row = {
    key: parameter.name,
    schema: structuredClone(parameter.schema),
    required: parameter.required === true,
    description: parameter.description || "",
    value: JSON.stringify(value),
    enabled: true,
    queryObjectSerialization: { version: 1, style: "form", explode: true },
  };
  encodeQueryObject(row);
  return row;
}
export function exportOpenAPIQueryObject(row) {
  encodeQueryObject(row);
  if (row.dynamic) fail("动态对象定义不能无损导出OpenAPI，请使用项目备份");
  return {
    example: parseQueryObject(row),
    style: "form",
    explode: true,
    allowReserved: false,
  };
}
export function assertQueryObjectCurlDefinition(request) {
  validateQueryObjectRequest(request);
  if (
    (request.query || []).some(
      (r) => hasQueryObjectSerialization(r) && r.enabled !== false && r.dynamic,
    )
  )
    fail("动态对象定义不能无损导出cURL");
}
