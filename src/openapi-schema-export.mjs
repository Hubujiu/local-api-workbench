// Normalize Schema positions only. Payload examples and extension values are opaque.
export function normalizeOpenAPI30Schemas(document) {
  let nodes = 0;
  const enter = (depth) => {
    if (++nodes > 50000 || depth > 60)
      throw Error("OpenAPI Schema 导出超过节点/深度上限");
  };
  const object = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const own = (value, key) => Object.hasOwn(value, key);
  const keywords = new Set([
    "$ref",
    "title",
    "multipleOf",
    "maximum",
    "exclusiveMaximum",
    "minimum",
    "exclusiveMinimum",
    "maxLength",
    "minLength",
    "pattern",
    "maxItems",
    "minItems",
    "uniqueItems",
    "maxProperties",
    "minProperties",
    "required",
    "enum",
    "type",
    "allOf",
    "oneOf",
    "anyOf",
    "not",
    "items",
    "properties",
    "additionalProperties",
    "description",
    "format",
    "default",
    "nullable",
    "discriminator",
    "readOnly",
    "writeOnly",
    "xml",
    "externalDocs",
    "example",
    "deprecated",
  ]);
  function schema(value, depth = 0) {
    enter(depth);
    if (value === true) return {};
    if (value === false) return { not: {} };
    if (!object(value)) throw Error("OpenAPI Schema 必须是对象或布尔值");
    for (const key of Object.keys(value))
      if (!keywords.has(key) && !key.startsWith("x-"))
        throw Error(
          "OpenAPI 3.0 导出暂不支持 Schema 关键字: " +
            key +
            "；请使用原始项目导出",
        );
    if (
      own(value, "type") &&
      !["string", "number", "integer", "boolean", "array", "object"].includes(
        value.type,
      )
    )
      throw Error("OpenAPI 3.0 不支持该 Schema type；请使用原始项目导出");
    for (const key of ["exclusiveMinimum", "exclusiveMaximum"])
      if (own(value, key) && typeof value[key] !== "boolean")
        throw Error(
          "OpenAPI 3.0 的 " + key + " 必须为布尔值；请使用原始项目导出",
        );
    const result = { ...value };
    if (own(value, "properties")) {
      if (!object(value.properties))
        throw Error("Schema properties 必须是对象");
      result.properties = Object.fromEntries(
        Object.entries(value.properties).map(([key, child]) => [
          key,
          schema(child, depth + 1),
        ]),
      );
    }
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      if (!own(value, key)) continue;
      if (!Array.isArray(value[key]))
        throw Error("Schema " + key + " 必须是数组");
      result[key] = value[key].map((child) => schema(child, depth + 1));
    }
    for (const key of ["items", "not"])
      if (own(value, key)) result[key] = schema(value[key], depth + 1);
    if (
      own(value, "additionalProperties") &&
      typeof value.additionalProperties !== "boolean"
    )
      result.additionalProperties = schema(
        value.additionalProperties,
        depth + 1,
      );
    return result;
  }
  function map(value, visitor, depth) {
    enter(depth);
    if (!object(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        visitor(child, depth + 1),
      ]),
    );
  }
  function content(value, depth) {
    return map(
      value,
      (media, level) => {
        if (!object(media)) return media;
        const result = { ...media };
        if (own(media, "schema"))
          result.schema = schema(media.schema, level + 1);
        if (media.encoding)
          result.encoding = map(
            media.encoding,
            (encoding, next) => {
              if (!object(encoding)) return encoding;
              return {
                ...encoding,
                ...(encoding.headers
                  ? { headers: map(encoding.headers, parameter, next + 1) }
                  : {}),
              };
            },
            level + 1,
          );
        return result;
      },
      depth,
    );
  }
  function parameter(value, depth) {
    enter(depth);
    if (!object(value)) return value;
    const result = { ...value };
    if (own(value, "schema")) result.schema = schema(value.schema, depth + 1);
    if (value.content) result.content = content(value.content, depth + 1);
    return result;
  }
  function body(value, depth) {
    enter(depth);
    if (!object(value)) return value;
    return {
      ...value,
      ...(value.content ? { content: content(value.content, depth + 1) } : {}),
    };
  }
  function response(value, depth) {
    const result = body(value, depth);
    if (object(value) && value.headers)
      result.headers = map(value.headers, parameter, depth + 1);
    return result;
  }
  function callback(value, depth) {
    return map(value, pathItem, depth);
  }
  function operation(value, depth) {
    enter(depth);
    if (!object(value)) return value;
    const result = { ...value };
    if (Array.isArray(value.parameters))
      result.parameters = value.parameters.map((p) => parameter(p, depth + 1));
    if (value.requestBody)
      result.requestBody = body(value.requestBody, depth + 1);
    if (value.responses)
      result.responses = map(value.responses, response, depth + 1);
    if (value.callbacks)
      result.callbacks = map(value.callbacks, callback, depth + 1);
    return result;
  }
  function pathItem(value, depth) {
    enter(depth);
    if (!object(value)) return value;
    const result = { ...value };
    if (Array.isArray(value.parameters))
      result.parameters = value.parameters.map((p) => parameter(p, depth + 1));
    for (const method of [
      "get",
      "put",
      "post",
      "delete",
      "options",
      "head",
      "patch",
      "trace",
    ])
      if (value[method]) result[method] = operation(value[method], depth + 1);
    return result;
  }
  const result = { ...document, paths: map(document.paths, pathItem, 0) };
  if (object(document.components)) {
    result.components = { ...document.components };
    for (const [category, visitor] of Object.entries({
      schemas: schema,
      parameters: parameter,
      headers: parameter,
      requestBodies: body,
      responses: response,
      callbacks: callback,
    }))
      if (document.components[category])
        result.components[category] = map(
          document.components[category],
          visitor,
          0,
        );
  }
  return structuredClone(result);
}
