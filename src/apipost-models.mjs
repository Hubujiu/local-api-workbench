import { schemaChildMode } from "../public/schema-positions.js";
// Independent mapping of the documented modern interchange model fields.
export function prepareApipostModels(models, resource, projectName) {
  if (!Array.isArray(models) || models.length > 100)
    throw Error("Apipost模型最多100项");
  const ids = new Map(),
    all = new Map(),
    folders = [];
  for (const model of models) {
    if (
      !model ||
      !["model", "folder"].includes(model.model_type) ||
      typeof model.name !== "string" ||
      !model.name.trim() ||
      model.name.length > 200 ||
      (model.model_type === "model" &&
        typeof model.schema !== "boolean" &&
        (!model.schema ||
          typeof model.schema !== "object" ||
          Array.isArray(model.schema)))
    )
      throw Error("Apipost模型或目录定义不完整");
    for (const value of [model.model_id, model.parent_id ?? "0"]) {
      if (
        typeof value !== "string" &&
        !(typeof value === "number" && Number.isSafeInteger(value))
      )
        throw Error("Apipost模型ID必须为字符串或安全整数");
    }
    if (model.model_type === "folder" && model.schema !== undefined) {
      const schema = model.schema;
      if (
        !schema ||
        typeof schema !== "object" ||
        Array.isArray(schema) ||
        Object.keys(schema).some(
          (key) => !["type", "properties"].includes(key),
        ) ||
        (schema.type !== undefined && schema.type !== "object") ||
        (schema.properties !== undefined &&
          (!schema.properties ||
            typeof schema.properties !== "object" ||
            Array.isArray(schema.properties) ||
            Object.keys(schema.properties).length))
      )
        throw Error("模型目录包含非空Schema，需手工迁移");
    }
    const id = String(model.model_id ?? "");
    if (!id || id === "0" || id.length > 200 || all.has(id))
      throw Error("Apipost模型ID为空、保留或重复");
    if (
      model.sort !== undefined &&
      (typeof model.sort !== "number" || !Number.isFinite(model.sort))
    )
      throw Error("Apipost模型排序无效");
    all.set(id, model);
    if (model.model_type === "model") ids.set(id, resource("model", id));
  }
  const parent = (model) => String(model.parent_id ?? "0");
  for (const [key, model] of all) {
    const seen = new Set([key]);
    let p = parent(model),
      depth = model.model_type === "folder" ? 1 : 0;
    while (p !== "0" && p !== "") {
      if (seen.has(p)) throw Error("Apipost模型目录存在循环");
      seen.add(p);
      if (++depth > 20) throw Error("Apipost模型目录最多20层");
      const node = all.get(p);
      if (!node || node.model_type !== "folder")
        throw Error("Apipost模型父目录不存在或不是目录");
      p = parent(node);
    }
    if (model.model_type === "folder")
      folders.push({
        id: resource("model-folder", key),
        name: model.name,
        parentId: ["0", ""].includes(parent(model))
          ? ""
          : resource("model-folder", parent(model)),
        ...(model.description
          ? { description: String(model.description) }
          : {}),
        ...(model.sort !== undefined ? { sort: model.sort } : {}),
      });
  }
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
        const childMode = schemaChildMode(key, value);
        return [key, convert(value, root, prefix, depth + 1, childMode)];
      }),
    );
  }
  const schemas = {},
    dictionary = [];
  for (const model of models.filter((m) => m.model_type === "model")) {
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
      ...(["0", ""].includes(parent(model))
        ? {}
        : { folderId: resource("model-folder", parent(model)) }),
      ...(model.sort !== undefined ? { sort: model.sort } : {}),
      schema,
    });
  }
  return { schemas, dictionary, folders, rewrite: (schema) => convert(schema) };
}
