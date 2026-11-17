// Validate the entire selected form-media map before constructing any rows.
// Empty Encoding Objects retain defaults; serialization options are unsupported.
export function validateOpenAPIFormEncoding(media, schema) {
  if (!Object.hasOwn(media, "encoding")) return;
  const object = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(media.encoding)) throw Error("OpenAPI 表单 encoding 必须是对象");
  if (Object.hasOwn(schema, "properties") && !object(schema.properties))
    throw Error("OpenAPI 表单 properties 必须是对象");
  const properties = schema.properties ?? {};
  for (const [key, value] of Object.entries(media.encoding)) {
    if (
      ["__proto__", "constructor", "prototype"].includes(key) ||
      !Object.hasOwn(properties, key)
    )
      throw Error("OpenAPI 表单 encoding 必须引用已声明的安全属性: " + key);
    if (!object(value))
      throw Error("OpenAPI 表单 encoding 条目必须是对象: " + key);
    // Specification extensions are legal OAS, but are not implemented here.
    if (Object.keys(value).length)
      throw Error("尚不支持 OpenAPI 表单自定义 encoding: " + key);
  }
}
