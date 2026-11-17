// Restricted form-query reserved expansion. Values are URI-template input:
// valid percent triplets are already encoded and remain byte-for-byte intact.
const own = (o, k) => Object.hasOwn(o, k);
const plain = (o) =>
  o !== null &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(o)) &&
  Reflect.ownKeys(o).every(
    (k) =>
      typeof k === "string" &&
      Object.getOwnPropertyDescriptor(o, k).enumerable &&
      own(Object.getOwnPropertyDescriptor(o, k), "value"),
  );
const fail = (s) => {
  throw Error("OpenAPI allowReserved: " + s);
};
export const hasReservedQuerySerialization = (row) =>
  row && own(row, "reservedQuerySerialization");
const LIMIT = 65536;
function scalar(value) {
  if (
    !["string", "number", "boolean"].includes(typeof value) ||
    (typeof value === "number" &&
      (!Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))))
  )
    fail("值须为文本、有限安全数值或布尔值");
  return String(value);
}
function ordinary(text) {
  try {
    return encodeURIComponent(text).replace(
      /[!'()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
  } catch {
    fail("无效Unicode");
  }
}
export function encodeReservedQueryValue(value) {
  const text = scalar(value);
  if (Buffer.byteLength(text) > LIMIT || /[\x00-\x1f\x7f']/.test(text))
    fail("值超过64KiB、含控制字符或暂不支持的原始单引号");
  // Reject malformed percent escapes/UTF-8, rather than letting downstream
  // URLSearchParams replace bytes. Do not use the decoded value for encoding.
  try {
    decodeURIComponent(text);
  } catch {
    fail("预编码值须为有效UTF-8百分号三元组");
  }
  let result = "";
  for (let i = 0; i < text.length; ) {
    if (text[i] === "%") {
      result += text.slice(i, i + 3);
      i += 3;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(i));
    i += char.length;
    // []# are not query-data characters; &=+ are form delimiters/space syntax.
    result += /^[A-Za-z0-9_.~\-:/?@!$()*,;]$/.test(char)
      ? char
      : ordinary(char);
  }
  if (Buffer.byteLength(result) > LIMIT) fail("编码值超过64KiB");
  return result;
}
export function encodeReservedQuery(row) {
  const property = Object.getOwnPropertyDescriptor(
    row,
    "reservedQuerySerialization",
  );
  const marker = property?.value;
  if (
    !property?.enumerable ||
    !own(property, "value") ||
    !plain(marker) ||
    Object.keys(marker).sort().join(",") !== "allowReserved,style,version" ||
    marker.version !== 1 ||
    marker.style !== "form" ||
    marker.allowReserved !== true
  )
    fail("序列化标记无效");
  if (own(row, "querySerialization")) fail("不能组合数组序列化标记");
  if (
    typeof row.key !== "string" ||
    !row.key ||
    Buffer.byteLength(row.key) > 1024 ||
    /[\x00-\x1f\x7f]/.test(row.key)
  )
    fail("参数名无效");
  const schema = row.schema;
  if (
    !plain(schema) ||
    !["string", "number", "integer", "boolean"].includes(schema.type) ||
    schema.nullable === true ||
    ["$ref", "allOf", "anyOf", "oneOf", "items", "properties"].some((k) =>
      own(schema, k),
    )
  )
    fail("首片仅支持明确非null的primitive Schema");
  return ordinary(row.key) + "=" + encodeReservedQueryValue(row.value);
}
export function validateReservedQueryRequest(request) {
  for (const group of ["headers", "path", "cookies", "form"])
    if ((request[group] || []).some(hasReservedQuerySerialization))
      fail("标记仅适用于Query");
  const marked = (request.query || []).filter(hasReservedQuerySerialization);
  if (!marked.length) return;
  if (request.scriptURLMode === "sdk" || request.scriptURLRuntime !== undefined)
    fail("暂不支持SDK URL模式");
  if (request.queryAddEqual === false) fail("首片空值固定保留等号");
  if (
    request.auth?.type &&
    !["none", "basic", "bearer"].includes(request.auth.type)
  )
    fail("该认证组合尚未验证保真与签名");
  let size = 0;
  for (const row of marked) {
    const pair = encodeReservedQuery(row);
    if (row.enabled !== false) size += Buffer.byteLength(pair) + 1;
  }
  if (size > LIMIT) fail("Query编码合计超过64KiB");
}
export function importReservedQuery(parameter, row, { oas3, swagger }) {
  if (parameter.allowReserved !== true) return undefined;
  if (
    !oas3 ||
    swagger ||
    (parameter.style !== undefined && parameter.style !== "form") ||
    (parameter.explode !== undefined &&
      typeof parameter.explode !== "boolean") ||
    own(parameter, "collectionFormat")
  )
    fail("首片仅支持OAS3 form标量");
  row.reservedQuerySerialization = {
    version: 1,
    style: "form",
    allowReserved: true,
  };
  encodeReservedQuery(row);
  return row;
}
export function exportReservedQuery(row) {
  encodeReservedQuery(row);
  if (row.dynamic) fail("动态定义不能无损导出OpenAPI，请使用项目备份");
  return { style: "form", allowReserved: true };
}

export function assertReservedQueryOpenAPI(request) {
  validateReservedQueryRequest(request);
  if (
    (request.query || []).some(hasReservedQuerySerialization) &&
    String(request.url || "")
      .split("#", 1)[0]
      .includes("?")
  )
    fail("OpenAPI导出不能保留URL内原始Query拼写；请使用项目备份或cURL");
}
