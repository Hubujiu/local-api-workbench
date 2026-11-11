// Explicit Cookie-pairs dialect, NOT a claim that OAS form serialization has
// one universally interoperable interpretation. No changes to unmarked rows.
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const LIMIT = 65536;
export const cookieDialectExtension = "x-local-api-cookie-dialect";
export const hasCookieSerialization = (row) =>
  row && own(row, "cookieSerialization");
const fail = (message) => {
  throw Error("OpenAPI Cookie对象: " + message);
};
function plain(value) {
  return (
    object(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === "string" &&
        descriptor.enumerable &&
        own(descriptor, "value")
      );
    })
  );
}
function name(value) {
  if (
    typeof value !== "string" ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value) ||
    Buffer.byteLength(value) > 1024 ||
    ["__proto__", "prototype", "constructor"].includes(value)
  )
    fail("名称须为1至1024字节Cookie token，不能为原型字段");
  return value;
}
function scalar(value) {
  if (
    !["string", "number", "boolean"].includes(typeof value) ||
    (typeof value === "number" &&
      (!Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))))
  )
    fail("属性值须为文本、有限安全数值或布尔值");
}
function encode(value) {
  try {
    return encodeURIComponent(String(value)).replace(
      /[!'()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
  } catch {
    fail("参数含无效Unicode");
  }
}
function schemaShape(schema, type) {
  if (
    !plain(schema) ||
    (type === "object"
      ? schema.type !== type
      : !["string", "number", "integer", "boolean"].includes(schema.type)) ||
    schema.nullable === true ||
    (own(schema, "const") && own(schema, "enum")) ||
    [
      "$ref",
      "allOf",
      "anyOf",
      "oneOf",
      "if",
      "then",
      "else",
      "not",
      "items",
      "prefixItems",
      "patternProperties",
      "dependentSchemas",
      "unevaluatedProperties",
    ].some((key) => own(schema, key))
  )
    fail("仅支持明确非null的扁平primitive对象Schema，不支持组合");
}
function descriptor(row) {
  const property = Object.getOwnPropertyDescriptor(row, "cookieSerialization"),
    marker = property?.value;
  if (
    !property?.enumerable ||
    !own(property, "value") ||
    !plain(marker) ||
    Object.keys(marker).sort().join(",") !== "dialect,explode,style,version" ||
    marker.version !== 1 ||
    marker.style !== "form" ||
    marker.explode !== true ||
    marker.dialect !== "cookie-pairs"
  )
    fail("序列化标记无效");
  name(row.key);
  schemaShape(row.schema, "object");
  if (own(row.schema, "properties")) {
    if (
      !plain(row.schema.properties) ||
      Object.keys(row.schema.properties).length > 1000
    )
      fail("properties须为最多1000项的对象");
    for (const [key, schema] of Object.entries(row.schema.properties)) {
      name(key);
      schemaShape(schema, "scalar");
    }
  }
  if (
    own(row.schema, "additionalProperties") &&
    typeof row.schema.additionalProperties !== "boolean"
  )
    schemaShape(row.schema.additionalProperties, "scalar");
  return marker;
}
export function parseCookieObject(row, value = row.value) {
  descriptor(row);
  if (typeof value !== "string" || Buffer.byteLength(value) > LIMIT)
    fail("值须为不超过64KiB的JSON对象文本");
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("JSON对象文本无效");
  }
  if (!plain(parsed) || Object.keys(parsed).length > 1000)
    fail("值须为最多1000项的扁平对象");
  for (const [key, item] of Object.entries(parsed)) {
    name(key);
    scalar(item);
    encode(item);
    const properties = row.schema.properties;
    const declared = properties && own(properties, key);
    if (!declared && row.schema.additionalProperties === false)
      fail("值含未声明属性");
    const schema = declared ? properties[key] : row.schema.additionalProperties;
    if (
      object(schema) &&
      (schema.type === "integer"
        ? !Number.isSafeInteger(item)
        : typeof item !== schema.type)
    )
      fail("属性值类型与Schema不一致");
  }
  return parsed;
}
export function cookieObjectPairs(row) {
  const pairs = Object.entries(parseCookieObject(row)).map(([key, value]) => [
    key,
    encode(value),
  ]);
  if (
    Buffer.byteLength(
      pairs.map(([key, value]) => key + "=" + value).join("; "),
    ) > LIMIT
  )
    fail("编码后参数超过64KiB");
  return pairs;
}
// Return undefined when there is no marked row so every legacy encoding and
// duplicate-name behavior remains byte-for-byte unchanged.
export function cookieObjectHeader(rows = [], policy = "raw") {
  if (!rows.some(hasCookieSerialization)) return undefined;
  if (policy !== "raw") fail("对象参数不能组合非raw Cookie编码策略");
  const names = new Set(),
    logical = new Set(),
    pairs = [];
  for (const row of rows) {
    const marked = hasCookieSerialization(row);
    const expanded = marked ? cookieObjectPairs(row) : [];
    if (row.enabled === false || !row.key) continue;
    if (logical.has(row.key)) fail("逻辑Cookie参数名重复");
    logical.add(row.key);
    if (!marked) {
      name(row.key);
      // Raw scalars sharing a header must not inject extra pairs or invalid
      // cookie octets. This restriction is confined to the new marked contract.
      const value = String(row.value);
      if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value))
        fail("同一请求中的普通Cookie值不是合法Cookie字节");
      expanded.push([row.key, value]);
    }
    for (const [key, value] of expanded) {
      if (names.has(key)) fail("展开后的Cookie名称冲突");
      names.add(key);
      pairs.push(key + "=" + value);
    }
  }
  const result = pairs.join("; ");
  if (Buffer.byteLength(result) > LIMIT) fail("Cookie编码总量超过64KiB");
  return result;
}
export function validateCookieObjectRequest(request) {
  for (const group of ["headers", "query", "path", "cookies", "form"]) {
    if (request[group] !== undefined && !Array.isArray(request[group]))
      fail("参数须为数组");
    if (
      group !== "cookies" &&
      (request[group] || []).some(hasCookieSerialization)
    )
      fail("标记仅适用于Cookie参数");
  }
  cookieObjectHeader(request.cookies, request.cookieEncoding ?? "raw");
  if (
    !(request.cookies || []).some(
      (row) => row.enabled !== false && hasCookieSerialization(row),
    )
  )
    return;
  if (
    (request.headers || []).some(
      (row) =>
        row.enabled !== false && String(row.key).toLowerCase() === "cookie",
    )
  )
    fail("对象参数不能与显式Cookie Header混用");
  const auth = request.auth;
  if (
    auth &&
    auth.type === "apiKey" &&
    auth.in !== "query" &&
    String(auth.key).toLowerCase() === "cookie"
  )
    fail("对象参数不能覆盖Cookie认证Header");
}
function selectedExample(parameter) {
  if (own(parameter, "example") && own(parameter, "examples"))
    fail("example和examples不能同时提供");
  if (own(parameter, "example")) return parameter.example;
  if (own(parameter, "examples")) {
    if (
      !plain(parameter.examples) ||
      Object.keys(parameter.examples).length !== 1
    )
      fail("examples须只有一个明确内联value");
    const item = Object.values(parameter.examples)[0];
    if (
      !plain(item) ||
      !own(item, "value") ||
      own(item, "$ref") ||
      own(item, "externalValue")
    )
      fail("examples须为已解析内联value");
    return item.value;
  }
  for (const key of ["default", "example"])
    if (own(parameter.schema, key)) return parameter.schema[key];
  return {};
}
export function importOpenAPICookieObject(parameter) {
  if (!own(parameter, cookieDialectExtension)) return undefined;
  if (
    parameter[cookieDialectExtension] !== "cookie-pairs-v1" ||
    parameter.in !== "cookie" ||
    parameter.schema?.type !== "object"
  )
    fail("Cookie约定扩展无效");
  if (
    own(parameter, "content") ||
    (parameter.style !== undefined && parameter.style !== "form") ||
    (parameter.explode !== undefined && parameter.explode !== true)
  )
    fail("仅支持form/explode=true对象");
  const value = selectedExample(parameter);
  if (!plain(value)) fail("选定值须为扁平对象");
  for (const [key, item] of Object.entries(value)) {
    name(key);
    scalar(item);
  }
  const row = {
    key: parameter.name,
    schema: structuredClone(parameter.schema),
    required: parameter.required === true,
    description: parameter.description || "",
    value: JSON.stringify(value),
    enabled: true,
    cookieSerialization: {
      version: 1,
      style: "form",
      explode: true,
      dialect: "cookie-pairs",
    },
  };
  cookieObjectPairs(row);
  return row;
}
export function exportOpenAPICookieObject(row) {
  if (!hasCookieSerialization(row)) return {};
  const example = parseCookieObject(row);
  if (row.dynamic) fail("动态对象定义不能无损导出OpenAPI，请使用项目备份");
  return {
    example,
    style: "form",
    explode: true,
    [cookieDialectExtension]: "cookie-pairs-v1",
  };
}
export function assertCookieObjectCurlDefinition(request) {
  validateCookieObjectRequest(request);
  if (
    (request.cookies || []).some(
      (row) =>
        row.enabled !== false && hasCookieSerialization(row) && row.dynamic,
    )
  )
    fail("动态对象定义不能无损导出cURL，请使用实际请求记录或项目备份");
}
