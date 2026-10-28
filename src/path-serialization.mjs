// Versioned, definition-preserving OAS3 scalar path serialization. No I/O.
const own = (value, key) => Object.hasOwn(value, key);
const fail = () => {
  throw Error(
    "OpenAPI scalar path serialization 无效或不支持；请使用原始定义/项目备份",
  );
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const hasPathSerialization = (request) =>
  (request.path || []).some((row) => row && own(row, "pathSerialization"));
export function assertPathScalar(value) {
  if (
    !["string", "number", "boolean"].includes(typeof value) ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    fail();
  const text = String(value);
  if (text.length > 65536 || /[\u0000-\u001f\u007f]/u.test(text)) fail();
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) fail();
  }
  return value;
}
export function assertPathValue(row, value, allowUnbound = false) {
  assertPathScalar(value);
  if (
    allowUnbound &&
    (value === "" || (typeof value === "string" && value.includes("{{")))
  )
    return value;
  const type = row.schema?.type;
  if (
    (type === "integer" &&
      (typeof value !== "number" || !Number.isInteger(value))) ||
    (type === "number" && typeof value !== "number") ||
    (type === "boolean" && typeof value !== "boolean") ||
    (type === "string" && typeof value !== "string")
  )
    fail();
  return value;
}
function metadata(row) {
  const marker = row.pathSerialization;
  if (
    !object(marker) ||
    Object.keys(marker).some(
      (key) => !["version", "style", "explode"].includes(key),
    ) ||
    marker.version !== 1 ||
    !["simple", "label", "matrix"].includes(marker.style) ||
    typeof marker.explode !== "boolean"
  )
    fail();
  if (
    typeof row.key !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(row.key) ||
    ["__proto__", "constructor", "prototype"].includes(row.key) ||
    row.required !== true ||
    row.enabled === false
  )
    fail();
  const schema = row.schema;
  if (
    !object(schema) ||
    !["string", "number", "integer", "boolean"].includes(schema.type) ||
    ["items", "properties", "allOf", "oneOf", "anyOf", "$ref", "nullable"].some(
      (key) => own(schema, key),
    )
  )
    fail();
  assertPathValue(row, row.value, true);
  return marker;
}
export function validatePathSerialization(request) {
  for (const group of ["query", "headers", "cookies", "form"])
    if (
      (request[group] || []).some((row) => row && own(row, "pathSerialization"))
    )
      fail();
  if (!hasPathSerialization(request)) return;
  if (request.scriptURLMode === "sdk" || request.scriptURLRuntime !== undefined)
    fail();
  if (typeof request.url !== "string") fail();
  const match =
    /^(?:https?:\/\/[^/?#]*|\{\{[^{}]+\}\})(\/[^?#]*)?(?:[?#]|$)/u.exec(
      request.url,
    );
  if (!match) fail();
  const path = match[1] || "";
  const segments = path.split("/");
  const names = new Set();
  for (const row of request.path || []) {
    if (!row || !own(row, "pathSerialization")) continue;
    metadata(row);
    if (names.has(row.key)) fail();
    names.add(row.key);
    const token = "{" + row.key + "}";
    if (
      segments.filter((part) => part === token).length !== 1 ||
      request.url.split(token).length !== 2
    )
      fail();
    if (
      (request.path || []).filter((other) => other?.key === row.key).length !==
      1
    )
      fail();
  }
}
export function importOpenAPIPath(parameter, isOpenAPI3) {
  const row = {
    key: parameter.name,
    schema: parameter.schema ?? { type: parameter.type || "string" },
    required: parameter.required === true,
    description: parameter.description || "",
    value: parameter.example ?? "",
    enabled: true,
  };
  if (!isOpenAPI3) return row;
  if (
    own(parameter, "content") ||
    own(parameter, "examples") ||
    own(parameter, "allowReserved") ||
    own(parameter, "allowEmptyValue") ||
    (own(parameter, "example") &&
      (parameter.example === null || parameter.example === ""))
  )
    fail();
  row.pathSerialization = {
    version: 1,
    style: own(parameter, "style") ? parameter.style : "simple",
    explode: own(parameter, "explode") ? parameter.explode : false,
  };
  metadata(row);
  return row;
}
export function pathParameterDefinition(row) {
  if (!own(row, "pathSerialization")) return { example: row.value };
  const marker = metadata(row);
  if (
    row.dynamic ||
    (typeof row.value === "string" && row.value.includes("{{"))
  )
    throw Error("OpenAPI path动态值不能导出为静态示例；请使用项目备份");
  return {
    style: marker.style,
    explode: marker.explode,
    ...(row.value === "" ? {} : { example: row.value }),
  };
}
const encode = (value) =>
  encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
  );
export function serializeRequestPath(request) {
  validatePathSerialization(request);
  let raw = request.url;
  for (const row of (request.path || []).filter(
    (item) => item.enabled !== false && item.key,
  )) {
    let encoded;
    if (own(row, "pathSerialization")) {
      const marker = metadata(row);
      if (
        row.dynamic ||
        row.value === "" ||
        (typeof row.value === "string" && row.value.includes("{{"))
      )
        throw Error("OpenAPI path参数尚未绑定；请提供标量值");
      assertPathValue(row, row.value);
      encoded = encode(row.value);
      if (marker.style === "label") encoded = "." + encoded;
      else if (marker.style === "matrix")
        encoded = ";" + encode(row.key) + "=" + encoded;
      if (encoded === "." || encoded === "..") fail();
    } else encoded = encodeURIComponent(row.value);
    raw = raw.replaceAll("{" + row.key + "}", encoded);
  }
  return raw;
}
// Validate referenced raw JSON values before generic interpolation can stringify them.
export function validatePathTemplateVariables(request, variables) {
  validatePathSerialization(request);
  for (const row of request.path || []) {
    if (
      !own(row, "pathSerialization") ||
      row.dynamic ||
      typeof row.value !== "string"
    )
      continue;
    for (const match of row.value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      if (own(variables, match[1])) assertPathScalar(variables[match[1]]);
    }
  }
}

// Whole-value bindings preserve JSON number/boolean identity; compound bindings
// are never converted to apparently valid path text by the generic interpolator.
export function bindPathTemplates(request, variables) {
  validatePathTemplateVariables(request, variables);
  for (const row of request.path || []) {
    if (
      !own(row, "pathSerialization") ||
      row.dynamic ||
      typeof row.value !== "string"
    )
      continue;
    const match = /^\{\{\s*([^{}]+?)\s*\}\}$/u.exec(row.value);
    if (match && own(variables, match[1])) {
      const value = assertPathValue(row, variables[match[1]]);
      if (typeof value !== "string") row.value = value;
    } else if (row.value.includes("{{") && row.schema.type !== "string") fail();
  }
  return request;
}
