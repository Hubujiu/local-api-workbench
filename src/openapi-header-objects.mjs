// Explicit versioned OAS3 simple object serialization. Existing Header rows are
// never inferred from schema or JSON-looking text. No I/O or implicit execution.
import { validateHeaderName } from "node:http";
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const LIMIT = 65536;
const fail = (detail) => {
  throw Error("OpenAPI Header对象: " + detail);
};
const scalarTypes = ["string", "number", "integer", "boolean"];
const compound = [
  "$ref",
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
];
export const hasHeaderSerialization = (row) =>
  row && own(row, "headerSerialization");
function plain(value) {
  return (
    object(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every((key) => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === "string" && property.enumerable && own(property, "value")
      );
    })
  );
}
// The 3.1-to-3.0 exporter preserves const/enum intersections as enum-only
// allOf entries. These constraints cannot redefine an object's wire shape.
function enumConjunction(schema) {
  if (!own(schema, "allOf")) return true;
  const entries = schema.allOf;
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    // Every entry also consumes Schema import/export nodes. Keep this ceiling
    // no smaller than that shared budget, so adding a const conjunction cannot
    // create an otherwise exportable definition that our reimport rejects.
    entries.length > 50000 ||
    Reflect.ownKeys(entries).length !== entries.length + 1
  )
    return false;
  for (let index = 0; index < entries.length; index++) {
    const property = Object.getOwnPropertyDescriptor(entries, String(index));
    if (!property?.enumerable || !own(property, "value")) return false;
    const entry = property.value;
    if (
      !plain(entry) ||
      Object.keys(entry).length !== 1 ||
      !own(entry, "enum") ||
      !Array.isArray(entry.enum)
    )
      return false;
  }
  return true;
}
function scalarSchema(schema) {
  if (
    !plain(schema) ||
    !scalarTypes.includes(schema.type) ||
    compound.some((key) => own(schema, key)) ||
    !enumConjunction(schema) ||
    schema.nullable === true
  )
    fail("属性须为明确的非null标量Schema");
}
function descriptor(row) {
  const property = Object.getOwnPropertyDescriptor(row, "headerSerialization"),
    marker = property?.value;
  if (
    !property?.enumerable ||
    !own(property, "value") ||
    !plain(marker) ||
    Object.keys(marker).length !== 3 ||
    Object.keys(marker).some(
      (key) => !["version", "style", "explode"].includes(key),
    ) ||
    marker.version !== 1 ||
    marker.style !== "simple" ||
    typeof marker.explode !== "boolean"
  )
    fail("序列化标记无效");
  if (
    typeof row.key !== "string" ||
    !row.key ||
    Buffer.byteLength(row.key) > 1024
  )
    fail("参数名须为1至1024字节文本");
  try {
    validateHeaderName(row.key);
  } catch {
    fail("Header名称无效");
  }
  if (row.key.toLowerCase() === "content-type")
    fail("Content-Type须由正文媒体定义");
  const schema = row.schema;
  if (
    !plain(schema) ||
    schema.type !== "object" ||
    compound.some((key) => own(schema, key)) ||
    !enumConjunction(schema) ||
    schema.nullable === true
  )
    fail("须为明确的扁平对象Schema");
  if (own(schema, "properties")) {
    if (
      !plain(schema.properties) ||
      Object.keys(schema.properties).length > 1000
    )
      fail("properties须为最多1000项的对象");
    for (const child of Object.values(schema.properties)) scalarSchema(child);
  }
  if (
    own(schema, "additionalProperties") &&
    typeof schema.additionalProperties !== "boolean"
  )
    scalarSchema(schema.additionalProperties);
  return marker;
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
      (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
    );
  } catch {
    fail("参数包含无效Unicode");
  }
}
export function parseHeaderObject(row, value = row.value) {
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
    scalar(item);
    encode(key);
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
export function encodeHeaderObject(row) {
  const marker = descriptor(row),
    entries = Object.entries(parseHeaderObject(row));
  const result = entries
    .map(
      ([key, value]) =>
        encode(key) + (marker.explode ? "=" : ",") + encode(value),
    )
    .join(",");
  if (Buffer.byteLength(result) > LIMIT) fail("编码后参数超过64KiB");
  return result;
}
export function validateHeaderObjectRequest(request) {
  if (!object(request)) fail("接口须为对象");
  for (const group of ["query", "headers", "path", "cookies", "form"]) {
    if (request[group] !== undefined && !Array.isArray(request[group]))
      throw Error(group + " 必须是对象数组");
    if (
      group !== "headers" &&
      (request[group] || []).some(hasHeaderSerialization)
    )
      fail("标记仅适用于Header参数");
  }
  let size = 0;
  for (const row of request.headers || [])
    if (hasHeaderSerialization(row)) {
      const value = encodeHeaderObject(row);
      if (row.enabled !== false)
        size += Buffer.byteLength(value) + Buffer.byteLength(row.key);
    }
  if (size > LIMIT) fail("对象Header编码总量超过64KiB");
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
    const example = Object.values(parameter.examples)[0];
    if (
      !plain(example) ||
      !own(example, "value") ||
      own(example, "$ref") ||
      own(example, "externalValue")
    )
      fail("examples须为已解析内联value");
    return example.value;
  }
  for (const key of ["default", "example"])
    if (own(parameter.schema, key)) return parameter.schema[key];
  return {};
}
export function importOpenAPIHeaderObject(parameter) {
  if (parameter.in !== "header" || parameter.schema?.type !== "object")
    return undefined;
  if (own(parameter, "content")) fail("content对象参数尚不支持");
  if (parameter.style !== undefined && parameter.style !== "simple")
    fail("仅支持simple对象序列化");
  if (parameter.explode !== undefined && typeof parameter.explode !== "boolean")
    fail("explode须为布尔值");
  const value = selectedExample(parameter);
  if (!plain(value)) fail("选定值须为扁平对象");
  for (const item of Object.values(value)) scalar(item);
  const row = {
    key: parameter.name,
    schema: structuredClone(parameter.schema),
    required: parameter.required === true,
    description: parameter.description || "",
    value: JSON.stringify(value),
    enabled: true,
    headerSerialization: {
      version: 1,
      style: "simple",
      explode: parameter.explode ?? false,
    },
  };
  encodeHeaderObject(row);
  return row;
}
export function assertHeaderObjectOpenAPIHeaders(request) {
  validateHeaderObjectRequest(request);
  const seen = new Map();
  for (const row of request.headers || []) {
    if (row.enabled === false || !row.key) continue;
    const key = String(row.key).toLowerCase();
    if (
      seen.has(key) &&
      (hasHeaderSerialization(row) || hasHeaderSerialization(seen.get(key)))
    )
      fail("OpenAPI不能保留同名Header对象与其他重复参数；请使用项目备份或cURL");
    seen.set(key, row);
  }
}
export function exportOpenAPIHeaderObject(row) {
  if (!hasHeaderSerialization(row)) return {};
  const marker = descriptor(row);
  encodeHeaderObject(row);
  if (row.dynamic) fail("动态对象定义不能无损导出OpenAPI，请使用项目备份");
  return {
    example: parseHeaderObject(row),
    style: "simple",
    explode: marker.explode,
  };
}
export function assertHeaderObjectCurlDefinition(request) {
  validateHeaderObjectRequest(request);
  if (
    (request.headers || []).some(
      (row) =>
        row.enabled !== false && hasHeaderSerialization(row) && row.dynamic,
    )
  )
    fail("动态对象定义不能无损导出cURL，请使用实际请求记录或项目备份");
}
