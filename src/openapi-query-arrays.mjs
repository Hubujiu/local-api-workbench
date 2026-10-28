// Canonical array parameters are explicit. Legacy scalar rows are never guessed
// from their schema or their spelling, and no user-supplied encoding is executed.
const LIMIT = 65536;
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (detail) => {
  throw Error("OpenAPI Query数组: " + detail);
};
export const hasQuerySerialization = (row) =>
  row && own(row, "querySerialization");

function descriptor(row) {
  const property = Object.getOwnPropertyDescriptor(row, "querySerialization");
  if (!property?.enumerable || !Object.hasOwn(property, "value"))
    fail("序列化标记须为自有数据属性");
  const value = property.value;
  if (
    object(value) &&
    (![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(
        (key) =>
          typeof key !== "string" ||
          !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"),
      ))
  )
    fail("序列化标记须为普通可枚举数据对象");
  if (
    !object(value) ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some(
      (key) => !["version", "style", "explode"].includes(key),
    ) ||
    value.version !== 1 ||
    value.style !== "form" ||
    typeof value.explode !== "boolean"
  )
    fail("序列化标记无效");
  if (
    typeof row.key !== "string" ||
    !row.key ||
    Buffer.byteLength(row.key) > 1024
  )
    fail("参数名须为1至1024字节文本");
  const schema = row.schema;
  if (
    !object(schema) ||
    schema.type !== "array" ||
    !object(schema.items) ||
    !["string", "number", "integer", "boolean"].includes(schema.items.type) ||
    ["allOf", "anyOf", "oneOf", "prefixItems"].some((key) =>
      own(schema, key),
    ) ||
    ["allOf", "anyOf", "oneOf", "$ref"].some((key) => own(schema.items, key))
  )
    fail("仅支持明确的标量items数组Schema");
  return value;
}

export function parseQueryArray(row, value = row.value) {
  descriptor(row);
  if (typeof value !== "string" || Buffer.byteLength(value) > LIMIT)
    fail("值须为不超过64KiB的JSON数组文本");
  let array;
  try {
    array = JSON.parse(value);
  } catch {
    fail("JSON数组文本无效");
  }
  if (!Array.isArray(array) || array.length > 1000)
    fail("值须为最多1000项的数组");
  for (const item of array) {
    if (
      !["string", "number", "boolean"].includes(typeof item) ||
      (typeof item === "number" &&
        (!Number.isFinite(item) ||
          (Number.isInteger(item) && !Number.isSafeInteger(item))))
    )
      fail("元素须为文本、有限安全数值或布尔值");
    if (item === "") fail("首版不支持空字符串元素；空数组可用[]表示");
    const type = row.schema.items.type;
    if (type === "integer" ? !Number.isSafeInteger(item) : typeof item !== type)
      fail("元素类型与items不一致");
  }
  return array;
}

export function encodeQueryArray(row) {
  const configuration = descriptor(row),
    array = parseQueryArray(row);
  const encode = (value) => {
    try {
      return encodeURIComponent(String(value)).replace(
        /[!'()*]/g,
        (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
      );
    } catch {
      fail("参数包含无效Unicode");
    }
  };
  const key = encode(row.key),
    values = array.map(encode);
  const pairs = !values.length
    ? []
    : configuration.explode
      ? values.map((value) => key + "=" + value)
      : [key + "=" + values.join(",")];
  if (Buffer.byteLength(pairs.join("&")) > LIMIT) fail("编码后参数超过64KiB");
  return pairs;
}

export function validateQueryArrayRequest(request) {
  if (!object(request)) fail("接口须为对象");
  for (const group of ["query", "headers", "path", "cookies", "form"])
    if (request[group] !== undefined && !Array.isArray(request[group]))
      throw Error(group + " 必须是对象数组");
  const marked = (request.query || []).filter(hasQuerySerialization);
  if (
    marked.length &&
    (request.scriptURLMode === "sdk" || request.scriptURLRuntime !== undefined)
  )
    fail("尚不支持与SDK URL模式组合");
  for (const group of ["headers", "path", "cookies", "form"])
    if ((request[group] || []).some(hasQuerySerialization))
      fail("标记仅适用于Query参数");
  let size = 0;
  for (const row of marked) {
    // Disabled definitions also remain well-formed so enabling cannot expose an
    // unvalidated descriptor. Dynamic definitions keep a valid stored baseline.
    const pairs = encodeQueryArray(row);
    if (
      row.enabled !== false &&
      pairs.length &&
      row.querySerialization.explode === false &&
      request.auth?.type === "aws" &&
      request.auth.addAuthDataToQuery === true
    )
      fail("CSV数组暂不支持AWS Query预签名；该签名路径会重写分隔符");
    if (row.enabled !== false)
      size += Buffer.byteLength(pairs.join("&")) + pairs.length;
  }
  if (size > LIMIT) fail("数组Query编码总量超过64KiB");
}

function selectedExample(parameter, schema, swagger) {
  if (own(parameter, "example") && own(parameter, "examples"))
    fail("example和examples不能同时提供");
  if (own(parameter, "example")) return parameter.example;
  if (own(parameter, "examples")) {
    if (
      !object(parameter.examples) ||
      Object.keys(parameter.examples).length !== 1
    )
      fail("examples须只有一个明确value，不能自动选择");
    const example = Object.values(parameter.examples)[0];
    if (
      !object(example) ||
      !own(example, "value") ||
      own(example, "$ref") ||
      own(example, "externalValue")
    )
      fail("不支持外部或无value的examples");
    return example.value;
  }
  if (swagger && own(parameter, "default")) return parameter.default;
  if (own(schema, "default")) return schema.default;
  if (own(schema, "example")) return schema.example;
  return [];
}

export function importOpenAPIQuery(parameters, { swagger = false } = {}) {
  return parameters
    .filter((parameter) => parameter.in === "query")
    .map((parameter) => {
      const schema =
        parameter.schema ??
        (swagger
          ? Object.fromEntries(
              Object.entries(parameter).filter(([key]) =>
                [
                  "type",
                  "items",
                  "default",
                  "enum",
                  "minimum",
                  "maximum",
                  "minItems",
                  "maxItems",
                  "uniqueItems",
                ].includes(key),
              ),
            )
          : { type: parameter.type || "string" });
      if (own(parameter, "content")) fail("暂不支持Query content参数");
      if (schema?.type === "object") fail("暂不支持对象Query参数");
      const row = {
        key: parameter.name,
        ...(parameter.allowEmptyValue === undefined
          ? {}
          : { allowEmptyValue: parameter.allowEmptyValue }),
        schema:
          typeof schema === "boolean" || Object.keys(schema).length
            ? schema
            : { type: "string" },
        required: parameter.required === true,
        description: parameter.description || "",
        value: parameter.example ?? parameter.schema?.default ?? "",
        enabled: true,
      };
      if (
        parameter.allowEmptyValue !== undefined &&
        typeof parameter.allowEmptyValue !== "boolean"
      )
        fail("allowEmptyValue须为布尔值");
      if (
        Array.isArray(schema?.type) ||
        ["allOf", "anyOf", "oneOf"].some((key) => own(schema, key))
      )
        fail("暂不支持Query联合类型或组合Schema");
      if (schema?.type !== "array") {
        if (
          own(schema, "items") ||
          (row.value !== null && typeof row.value === "object") ||
          Array.isArray(schema?.example) ||
          Array.isArray(schema?.default)
        )
          fail("数组或对象Query值须有明确受支持的Schema");
        return row;
      }
      if (
        parameter.allowReserved !== undefined &&
        parameter.allowReserved !== false
      )
        fail("尚不支持allowReserved:true或非布尔值");
      let explode;
      if (swagger) {
        const format = own(parameter, "collectionFormat")
          ? parameter.collectionFormat
          : "csv";
        if (!["multi", "csv"].includes(format)) fail("仅支持Swagger multi/csv");
        if (own(parameter, "style") || own(parameter, "explode"))
          fail("Swagger不能混用OAS3序列化字段");
        explode = format === "multi";
      } else {
        if (
          (own(parameter, "style") ? parameter.style : "form") !== "form" ||
          own(parameter, "collectionFormat")
        )
          fail("仅支持OAS3 form序列化");
        explode = own(parameter, "explode") ? parameter.explode : true;
        if (typeof explode !== "boolean") fail("explode须为布尔值");
      }
      row.querySerialization = { version: 1, style: "form", explode };
      const example = selectedExample(parameter, schema, swagger);
      if (!Array.isArray(example)) fail("数组example/default须为数组");
      row.value = JSON.stringify(example);
      encodeQueryArray(row);
      return row;
    });
}

export function exportOpenAPIQueryArray(row) {
  if (!hasQuerySerialization(row)) return {};
  const configuration = descriptor(row);
  encodeQueryArray(row);
  if (row.dynamic) fail("动态数组定义不能无损导出OpenAPI，请使用项目备份");
  return {
    example: parseQueryArray(row),
    style: "form",
    explode: configuration.explode,
    allowReserved: false,
  };
}

export function assertQueryArrayCurlDefinition(request) {
  validateQueryArrayRequest(request);
  if (
    (request.query || []).some(
      (row) =>
        row.enabled !== false && hasQuerySerialization(row) && row.dynamic,
    )
  )
    fail("动态数组定义不能无损导出cURL，请使用实际请求记录或项目备份");
}
