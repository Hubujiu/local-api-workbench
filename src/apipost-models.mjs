// Independent mapping of the documented modern interchange model fields.
export function prepareApipostModels(models, resource, projectName) {
  if (!Array.isArray(models) || models.length > 100)
    throw Error("Apipost模型最多100项");
  const ids = new Map();
  for (const model of models) {
    if (
      !model ||
      model.model_type !== "model" ||
      !["0", ""].includes(String(model.parent_id ?? "0")) ||
      typeof model.name !== "string" ||
      !model.name.trim() ||
      model.name.length > 200 ||
      (typeof model.schema !== "boolean" &&
        (!model.schema ||
          typeof model.schema !== "object" ||
          Array.isArray(model.schema)))
    )
      throw Error("Apipost仅支持完整平级模型定义");
    const id = String(model.model_id ?? "");
    if (!id || ids.has(id)) throw Error("Apipost模型ID为空或重复");
    ids.set(id, resource("model", id));
  }
  const schemaMaps = new Set([
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
  ]);
  const schemaLists = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
  const schemaValues = new Set([
    "additionalProperties",
    "additionalItems",
    "unevaluatedProperties",
    "unevaluatedItems",
    "contains",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
  ]);
  let nodes = 0;
  function convert(
    input,
    root = input,
    prefix = "",
    depth = 0,
    mode = "schema",
  ) {
    if (++nodes > 50000 || depth > 40)
      throw Error("Apipost模型结构超过节点/深度上限");
    if (Array.isArray(input))
      return input.map((x) =>
        convert(
          x,
          root,
          prefix,
          depth + 1,
          mode === "list" ? "schema" : "literal",
        ),
      );
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => {
        if (mode !== "schema") {
          const childMode =
            mode === "map" || (mode === "dependencies" && !Array.isArray(value))
              ? "schema"
              : "literal";
          return [key, convert(value, root, prefix, depth + 1, childMode)];
        }
        if (
          [
            "APIPOST_REFS",
            "ECHOAPI_REFS",
            "x-schema-refs",
            "x-schema-overrides",
          ].includes(key) &&
          value &&
          Object.keys(value).length
        )
          throw Error("Apipost自定义模型组合需手工迁移");
        if (key === "$ref" && typeof value !== "string")
          throw Error("Apipost模型引用必须为字符串");
        if ((key === "$ref" || key === "ref") && typeof value === "string") {
          if (ids.has(value))
            return ["$ref", "#/components/schemas/" + ids.get(value)];
          if (!value.startsWith("#"))
            throw Error("Apipost模型引用不支持远程资源");
          let pointer;
          try {
            pointer = decodeURIComponent(value.slice(1));
          } catch {
            throw Error("Apipost模型引用编码无效");
          }
          if (pointer === "" && prefix) return ["$ref", prefix];
          if (pointer !== "" && !pointer.startsWith("/"))
            throw Error("Apipost模型引用格式无效");
          const segments = pointer.slice(1).split("/");
          if (segments.some((s) => /~(?:[^01]|$)/.test(s)))
            throw Error("Apipost模型引用转义无效");
          const parts = segments.map((s) =>
            s.replaceAll("~1", "/").replaceAll("~0", "~"),
          );
          if (
            parts.some((s) =>
              ["__proto__", "constructor", "prototype"].includes(s),
            )
          )
            throw Error("Apipost模型引用不安全");
          let target = root,
            exists = true;
          if (pointer)
            for (const part of parts) {
              if (
                !target ||
                typeof target !== "object" ||
                !Object.hasOwn(target, part)
              ) {
                exists = false;
                break;
              }
              target = target[part];
            }
          if (exists)
            return ["$ref", prefix ? prefix + pointer : "#" + pointer];
          const modelId =
            parts.length === 2 && parts[0] === "definitions"
              ? parts[1]
              : parts.length === 3 &&
                  parts[0] === "components" &&
                  parts[1] === "schemas"
                ? parts[2]
                : null;
          if (modelId && ids.has(modelId))
            return ["$ref", "#/components/schemas/" + ids.get(modelId)];
          throw Error("Apipost模型引用不存在");
        }
        const childMode = schemaMaps.has(key)
          ? "map"
          : schemaLists.has(key)
            ? "list"
            : key === "dependencies"
              ? "dependencies"
              : key === "items"
                ? Array.isArray(value)
                  ? "list"
                  : "schema"
                : schemaValues.has(key)
                  ? "schema"
                  : "literal";
        return [key, convert(value, root, prefix, depth + 1, childMode)];
      }),
    );
  }
  const schemas = {},
    dictionary = [];
  for (const model of models) {
    const id = ids.get(String(model.model_id));
    const schema = convert(
      model.schema,
      model.schema,
      "#/components/schemas/" + id,
    );
    if (
      schema &&
      typeof schema === "object" &&
      model.description &&
      !schema.description
    )
      schema.description = String(model.description);
    schemas[id] = schema;
    dictionary.push({
      id,
      name: projectName + " / " + String(model.display_name || model.name),
      schema,
    });
  }
  return { schemas, dictionary, rewrite: (schema) => convert(schema) };
}
