export function openapiExample(media, fallback = {}) {
  if (media && Object.hasOwn(media, "example")) return media.example;
  for (const example of Object.values(media?.examples || {})) {
    if (example && Object.hasOwn(example, "value")) return example.value;
  }
  return fallback;
}
export function importOpenAPIBody(requestBody) {
  if (!requestBody)
    return {
      bodyType: "none",
      body: "",
      schema: {},
      form: [],
      contentType: "",
    };
  const content = requestBody.content || {};
  const names = Object.keys(content);
  if (!names.length) throw Error("OpenAPI requestBody 缺少媒体类型");
  const mediaName =
    names.find((name) => name.toLowerCase() === "application/json") || names[0];
  if (/[\r\n]/.test(mediaName)) throw Error("媒体类型包含非法换行");
  const mime = mediaName.split(";")[0].trim().toLowerCase();
  const media = content[mediaName],
    schema = media?.schema || {};
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
  if (!example || typeof example !== "object" || Array.isArray(example))
    throw Error("表单示例必须是对象");
  const properties = schema.properties || {};
  const keys = [
    ...new Set([...Object.keys(properties), ...Object.keys(example)]),
  ];
  const form = keys.map((key) => {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw Error("不安全的表单字段");
    const definition = properties[key] || {},
      encoding = media.encoding?.[key] || {};
    if (Object.keys(encoding).length)
      throw Error("尚不支持 OpenAPI 表单自定义 encoding");
    if (
      ["array", "object"].includes(definition.type) ||
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
  let schema = request.schema || {},
    example = request.body;
  if (type === "json") {
    try {
      example = JSON.parse(request.body || "{}");
    } catch {
      example = undefined;
    }
  }
  if (["urlencoded", "form-data"].includes(type)) {
    const properties = Object.create(null),
      required = [],
      values = Object.create(null);
    for (const field of request.form || []) {
      if (field.enabled === false || !field.key) continue;
      if (["__proto__", "prototype", "constructor"].includes(field.key))
        throw Error("不安全的表单字段");
      if (Object.hasOwn(properties, field.key))
        throw Error("OpenAPI 导出不支持重复表单键");
      properties[field.key] =
        field.type === "file"
          ? { type: "string", format: "binary" }
          : structuredClone(field.schema || { type: "string" });
      if (field.required) required.push(field.key);
      if (field.description)
        properties[field.key].description = field.description;
      if (field.type !== "file") {
        let value = field.value ?? "";
        if (
          ["boolean", "number", "integer"].includes(properties[field.key].type)
        ) {
          try {
            const parsed = JSON.parse(value);
            if (
              typeof parsed === properties[field.key].type ||
              (properties[field.key].type === "integer" &&
                Number.isInteger(parsed))
            )
              value = parsed;
          } catch {}
        }
        values[field.key] = value;
      }
    }
    schema = {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    };
    example = values;
  }
  return {
    content: {
      [media]: { schema, ...(example === undefined ? {} : { example }) },
    },
  };
}
