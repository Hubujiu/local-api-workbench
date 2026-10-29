import { validateOpenAPIFormEncoding } from "./openapi-form-encoding.mjs";
import { assertMultipartMediaExportable } from "./multipart-part-media.mjs";
function requestBodyAnnotations(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw Error("OpenAPI requestBody 必须是对象");
  for (const [key, type] of [
    ["required", "boolean"],
    ["description", "string"],
  ]) {
    if (Object.hasOwn(body, key) && typeof body[key] !== type)
      throw Error("OpenAPI requestBody " + key + " 类型无效");
  }
  return Object.fromEntries(
    Object.entries(body)
      .filter(
        ([key]) =>
          key === "required" || key === "description" || key.startsWith("x-"),
      )
      .map(([key, value]) => [key, structuredClone(value)]),
  );
}

export function openapiExample(media, fallback = {}) {
  if (media && Object.hasOwn(media, "example")) return media.example;
  for (const example of Object.values(media?.examples || {})) {
    if (example && Object.hasOwn(example, "value")) return example.value;
  }
  return fallback;
}
function hasComposition(schema) {
  return (
    schema &&
    typeof schema === "object" &&
    ["allOf", "anyOf", "oneOf"].some((key) => Object.hasOwn(schema, key))
  );
}
export function importOpenAPIBody(requestBody) {
  if (requestBody === undefined)
    return {
      bodyType: "none",
      body: "",
      schema: {},
      form: [],
      contentType: "",
    };
  requestBodyAnnotations(requestBody);
  const content = requestBody.content || {};
  const names = Object.keys(content);
  if (!names.length) throw Error("OpenAPI requestBody 缺少媒体类型");
  const mediaName =
    names.find((name) => name.toLowerCase() === "application/json") || names[0];
  if (/[\r\n]/.test(mediaName)) throw Error("媒体类型包含非法换行");
  const mime = mediaName.split(";")[0].trim().toLowerCase();
  const media = content[mediaName],
    schema = media?.schema ?? {};
  const base = { schema, form: [], contentType: mediaName };
  if (mime === "application/json" || mime.endsWith("+json"))
    return {
      ...base,
      bodyType: "json",
      body: JSON.stringify(openapiExample(media), null, 2),
    };
  if (
    mime.startsWith("text/") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript"
  ) {
    const value = openapiExample(media, "");
    if (typeof value !== "string") throw Error("文本请求体示例必须是字符串");
    return { ...base, bodyType: "raw", body: value };
  }
  if (
    !["application/x-www-form-urlencoded", "multipart/form-data"].includes(mime)
  )
    throw Error("尚不支持该 OpenAPI 请求体媒体类型: " + mediaName);
  const example = openapiExample(media, {});
  if (hasComposition(schema)) throw Error("尚不支持 OpenAPI 复杂表单 Schema");
  if (schema.type !== undefined && schema.type !== "object")
    throw Error("OpenAPI 表单根类型必须是 object");
  if (!example || typeof example !== "object" || Array.isArray(example))
    throw Error("表单示例必须是对象");
  validateOpenAPIFormEncoding(media, schema);
  const properties = schema.properties || {};
  const keys = [
    ...new Set([...Object.keys(properties), ...Object.keys(example)]),
  ];
  const form = keys.map((key) => {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw Error("不安全的表单字段");
    const definition = properties[key] ?? {};
    if (
      ["array", "object"].includes(definition.type) ||
      hasComposition(definition) ||
      definition.properties ||
      definition.items
    )
      throw Error("尚不支持 OpenAPI 复杂表单字段: " + key);
    const file =
      definition.format === "binary" || definition.contentEncoding === "base64";
    if (file && mime !== "multipart/form-data")
      throw Error("文件字段需要 multipart/form-data");
    const value = Object.hasOwn(example, key)
      ? example[key]
      : Object.hasOwn(definition, "example")
        ? definition.example
        : (definition.default ?? "");
    if (!file && value !== null && typeof value === "object")
      throw Error("表单字段示例必须是标量");
    return {
      key,
      value: file ? "" : value == null ? "" : String(value),
      type: file ? "file" : "text",
      enabled: true,
      required: Array.isArray(schema.required) && schema.required.includes(key),
      description: definition.description || "",
      schema: definition,
      ...(!Object.hasOwn(properties, key) ? { schemaDefined: false } : {}),
      ...(file ? { requiresFile: true, filename: key } : {}),
    };
  });
  return {
    ...base,
    bodyType: mime === "multipart/form-data" ? "form-data" : "urlencoded",
    body: "",
    form,
    contentType: mime === "multipart/form-data" ? "" : mediaName,
  };
}

export function exportOpenAPIBody(request) {
  assertMultipartMediaExportable(request, "OpenAPI");
  const type = request.bodyType;
  if (!["json", "raw", "urlencoded", "form-data"].includes(type))
    return undefined;
  const header = [...(request.headers || [])]
    .reverse()
    .find(
      (h) =>
        h.enabled !== false && String(h.key).toLowerCase() === "content-type",
    )?.value;
  let media =
    type === "form-data"
      ? "multipart/form-data"
      : type === "urlencoded"
        ? "application/x-www-form-urlencoded"
        : header || (type === "json" ? "application/json" : "text/plain");
  let schema = request.schema ?? {},
    example = request.body;
  if (type === "json") {
    try {
      example = JSON.parse(request.body || "{}");
    } catch {
      example = undefined;
    }
  }
  if (["urlencoded", "form-data"].includes(type)) {
    const formKeys = new Set((request.form || []).map((field) => field.key));
    const properties = Object.create(null),
      required = (Array.isArray(schema.required) ? schema.required : []).filter(
        (key) =>
          !Object.hasOwn(schema.properties || {}, key) && !formKeys.has(key),
      ),
      seen = new Set(),
      values = Object.create(null);
    for (const field of request.form || []) {
      if (field.enabled === false || !field.key) continue;
      if (["__proto__", "prototype", "constructor"].includes(field.key))
        throw Error("不安全的表单字段");
      if (seen.has(field.key)) throw Error("OpenAPI 导出不支持重复表单键");
      seen.add(field.key);
      let definition =
        field.type === "file" &&
        field.schema?.format !== "binary" &&
        field.schema?.contentEncoding !== "base64"
          ? { type: "string", format: "binary" }
          : structuredClone(field.schema ?? { type: "string" });
      if (field.required) required.push(field.key);
      if (field.description) {
        if (typeof definition === "boolean")
          definition = {
            allOf: [definition],
            description: field.description,
          };
        else definition.description = field.description;
      }
      if (field.schemaDefined !== false) properties[field.key] = definition;
      if (field.type !== "file") {
        let value = field.value ?? "";
        if (["boolean", "number", "integer"].includes(definition.type)) {
          try {
            const parsed = JSON.parse(value);
            if (
              typeof parsed === definition.type ||
              (definition.type === "integer" && Number.isInteger(parsed))
            )
              value = parsed;
          } catch {}
        }
        values[field.key] = value;
      }
    }
    if (typeof schema !== "boolean") {
      const original = structuredClone(schema);
      delete original.required;
      schema = {
        ...(!request.openapiOperation?.requestBody &&
        !Object.keys(original).length
          ? { type: "object" }
          : {}),
        ...original,
        properties,
        ...(required.length ? { required } : {}),
      };
    }
    example = values;
  }
  return {
    ...requestBodyAnnotations(request.openapiOperation?.requestBody),
    content: {
      [media]: { schema, ...(example === undefined ? {} : { example }) },
    },
  };
}
