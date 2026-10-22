import Ajv from "ajv";
import addFormats from "ajv-formats";
import { formatNames } from "ajv-formats/dist/formats.js";

const formats = new Set(formatNames);
const keywords = new Set(
  "$schema $id $ref $comment definitions $defs type enum const multipleOf maximum exclusiveMaximum minimum exclusiveMinimum maxLength minLength pattern format items additionalItems maxItems minItems uniqueItems contains maxProperties minProperties required properties patternProperties additionalProperties dependencies propertyNames if then else allOf anyOf oneOf not title description default examples example readOnly writeOnly contentMediaType contentEncoding".split(
    " ",
  ),
);
const caches = new Map();

function boundedJSON(value, byteLimit, depthLimit, nodeLimit) {
  let nodes = 0;
  const active = new Set();
  function copy(value, depth) {
    if (++nodes > nodeLimit || depth > depthLimit)
      throw Error("JSON Schema 输入超过节点或深度上限");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (
      !value ||
      typeof value !== "object" ||
      Object.getOwnPropertySymbols(value).length
    )
      throw Error("JSON Schema 输入必须是 JSON 值");
    if (active.has(value)) throw Error("JSON Schema 输入不能循环引用");
    if (
      !Array.isArray(value) &&
      ![null, Object.prototype].includes(Object.getPrototypeOf(value))
    )
      throw Error("JSON Schema 输入必须是普通 JSON 对象");
    active.add(value);
    const result = Array.isArray(value) ? [] : Object.create(null);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i))
          throw Error("JSON Schema 输入数组不能有空洞");
        result.push(copy(value[i], depth + 1));
      }
    } else
      for (const key of Object.keys(value))
        result[key] = copy(value[key], depth + 1);
    active.delete(value);
    return result;
  }
  const result = copy(value, 0),
    text = JSON.stringify(result);
  let bytes = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    bytes += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
    if (bytes > byteLimit) throw Error("JSON Schema 输入超过字节上限");
  }
  return result;
}

function inspectSchema(schema) {
  if (typeof schema === "boolean") return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw Error("JSON Schema 必须是对象或布尔值");
  for (const key of Object.keys(schema))
    if (!keywords.has(key) && !key.startsWith("x-"))
      throw Error("不支持的 JSON Schema 关键字: " + key);
  if (schema.$schema !== undefined) {
    if (
      !/^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(schema.$schema)
    )
      throw Error("当前 jsonSchema 仅支持 draft-07");
    schema.$schema = "http://json-schema.org/draft-07/schema#";
  }
  if (
    schema.$ref !== undefined &&
    (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#"))
  )
    throw Error("jsonSchema 仅允许本地引用，不下载外部 Schema");
  if (schema.format !== undefined && !formats.has(schema.format))
    throw Error("不支持的 JSON Schema format: " + String(schema.format));
  for (const key of ["properties", "patternProperties", "definitions", "$defs"])
    if (
      schema[key] &&
      typeof schema[key] === "object" &&
      !Array.isArray(schema[key])
    )
      for (const child of Object.values(schema[key])) inspectSchema(child);
  for (const key of ["allOf", "anyOf", "oneOf"])
    if (Array.isArray(schema[key]))
      for (const child of schema[key]) inspectSchema(child);
  for (const key of [
    "additionalItems",
    "additionalProperties",
    "contains",
    "propertyNames",
    "if",
    "then",
    "else",
    "not",
  ])
    if (Object.hasOwn(schema, key)) inspectSchema(schema[key]);
  if (Array.isArray(schema.items))
    for (const child of schema.items) inspectSchema(child);
  else if (Object.hasOwn(schema, "items")) inspectSchema(schema.items);
  if (schema.dependencies && typeof schema.dependencies === "object")
    for (const child of Object.values(schema.dependencies))
      if (!Array.isArray(child)) inspectSchema(child);
}

globalThis.__boundedJSONSchema = (schema, data, options = {}) => {
  options = boundedJSON(options, 1024, 3, 20);
  if (!options || Array.isArray(options) || typeof options !== "object")
    throw Error("jsonSchema options 必须是对象");
  for (const [key, value] of Object.entries(options))
    if (!["allErrors", "verbose"].includes(key) || typeof value !== "boolean")
      throw Error("不支持的 jsonSchema option: " + key);
  const normalized = {
    allErrors: options.allErrors ?? true,
    verbose: options.verbose ?? false,
  };
  schema = boundedJSON(schema, 65536, 32, 5000);
  data = boundedJSON(data, 262144, 64, 10000);
  inspectSchema(schema);
  const optionKey = JSON.stringify(normalized),
    schemaKey = JSON.stringify(schema);
  let cache = caches.get(optionKey);
  if (!cache) {
    if (caches.size >= 2) caches.clear();
    const ajv = new Ajv({
      ...normalized,
      strict: false,
      logger: false,
      ownProperties: true,
      addUsedSchema: false,
    });
    addFormats(ajv, { keywords: false });
    cache = { ajv, schemas: new Map() };
    caches.set(optionKey, cache);
  }
  let validate = cache.schemas.get(schemaKey);
  if (!validate) {
    if (cache.schemas.size >= 8) {
      cache.ajv.removeSchema();
      cache.schemas.clear();
    }
    validate = cache.ajv.compile(schema);
    cache.schemas.set(schemaKey, validate);
  }
  const valid = validate(data);
  if (typeof valid !== "boolean") throw Error("jsonSchema 不支持异步 Schema");
  return {
    valid,
    message:
      "JSON Schema: " + cache.ajv.errorsText(validate.errors).slice(0, 4000),
  };
};
