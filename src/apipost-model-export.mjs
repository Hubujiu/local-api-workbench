import { isDeepStrictEqual } from "node:util";
import { validateResourceJSON } from "./api-resource-lifecycle.mjs";
import { validateModelFolders } from "../public/model-folders.js";
import { schemaChildMode } from "../public/schema-positions.js";
import { prepareApipostModels } from "./apipost-models.mjs";
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (message) => {
  throw Error("原生模型导出：" + message + "；请使用项目备份");
};
const exactKeys = (v, keys) => {
  if (!object(v) || Object.keys(v).some((k) => !keys.includes(k)))
    fail("未知定义字段");
};
const esc = (s) => s.replaceAll("~", "~0").replaceAll("/", "~1");
const parts = (ref) => {
  let s;
  try {
    s = decodeURIComponent(ref.slice(1));
  } catch {
    fail("引用编码无效");
  }
  if (!s.startsWith("/") || s.split("/").some((x) => /~(?:[^01]|$)/.test(x)))
    fail("引用格式无效");
  const p = s
    .slice(1)
    .split("/")
    .map((x) => x.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (p.some((x) => ["__proto__", "prototype", "constructor"].includes(x)))
    fail("不安全引用");
  return p;
};
const exists = (root, path) => {
  let v = root;
  for (const p of path) {
    if (!v || typeof v !== "object" || !Object.hasOwn(v, p)) return false;
    v = v[p];
  }
  return true;
};

// A bounded definition adapter, never a schema evaluator or reference expander.
export function prepareApipostModelExport(project, id) {
  const dictionary = project.dictionary ?? [],
    folders = project.modelFolders ?? [],
    components = project.openapiComponents ?? {};
  validateResourceJSON({ dictionary, folders, components });
  if (!Array.isArray(dictionary) || dictionary.length + folders.length > 100)
    fail("模型及目录合计最多100项");
  validateModelFolders(project);
  exactKeys(components, ["schemas"]);
  const schemas = components.schemas ?? {};
  if (!object(schemas)) fail("schemas必须为对象");
  const models = new Map(),
    folderIds = new Map(),
    prefix = project.name + " / ";
  for (const f of folders) {
    exactKeys(f, ["id", "name", "parentId", "description", "sort"]);
    folderIds.set(f.id, id("model-folder", f.id));
  }
  for (const m of dictionary) {
    exactKeys(m, ["id", "name", "folderId", "sort", "schema"]);
    if (
      typeof m.id !== "string" ||
      !m.id ||
      m.id.length > 200 ||
      models.has(m.id) ||
      folderIds.has(m.id) ||
      ["__proto__", "prototype", "constructor"].includes(m.id)
    )
      fail("模型ID无效或冲突");
    if (
      typeof m.name !== "string" ||
      !m.name.startsWith(prefix) ||
      !m.name.slice(prefix.length).trim() ||
      m.name.slice(prefix.length).length > 200
    )
      fail("模型名称必须精确匹配当前项目名称空间");
    if (
      !Object.hasOwn(schemas, m.id) ||
      !isDeepStrictEqual(schemas[m.id], m.schema)
    )
      fail("dictionary与components不一致");
    if (typeof m.schema !== "boolean" && !object(m.schema))
      fail("schema必须为对象或布尔值");
    if (m.sort !== undefined && !Number.isFinite(m.sort)) fail("排序无效");
    models.set(m.id, id("model", m.id));
  }
  if (Object.keys(schemas).length !== models.size) fail("组件缺少对应模型");
  let nodes = 0;
  const rewrite = (input, current) => {
    const visit = (v, root, mode = "schema", depth = 0) => {
      if (++nodes > 50000 || depth > 40) fail("结构超过节点/深度上限");
      if (Array.isArray(v))
        return v.map((x) =>
          visit(x, root, mode === "list" ? "schema" : "literal", depth + 1),
        );
      if (!v || typeof v !== "object") return v;
      return Object.fromEntries(
        Object.entries(v).map(([k, value]) => {
          if (mode !== "schema") {
            const child =
              mode === "map" ||
              (mode === "dependencies" && !Array.isArray(value))
                ? "schema"
                : "literal";
            return [k, visit(value, root, child, depth + 1)];
          }
          if (
            [
              "$id",
              "$anchor",
              "$dynamicAnchor",
              "$dynamicRef",
              "$recursiveAnchor",
              "$recursiveRef",
              "APIPOST_REFS",
              "ECHOAPI_REFS",
              "x-schema-refs",
              "x-schema-overrides",
              "ref",
            ].includes(k)
          )
            fail("未支持的模型引用锚点或模型组合");
          if (k === "$ref") {
            if (typeof value !== "string" || !value.startsWith("#"))
              fail("不支持外部或别名引用");
            if (value === "#") return [k, value];
            const p = parts(value);
            if (p[0] === "components" && p[1] === "schemas") {
              const target = p[2];
              if (!models.has(target)) fail("模型引用不存在");
              if (p.length === 3) return [k, models.get(target)];
              if (target !== current) fail("不支持跨模型子路径");
              const tail = p.slice(3);
              if (!exists(root, tail)) fail("局部引用不存在");
              return [k, "#/" + tail.map(esc).join("/")];
            }
            if (!exists(root, p)) fail("局部引用不存在");
            return [k, value];
          }
          return [k, visit(value, root, schemaChildMode(k, value), depth + 1)];
        }),
      );
    };
    return visit(input, input);
  };
  const native = [
    ...folders.map((f) => ({
      model_id: folderIds.get(f.id),
      model_type: "folder",
      name: f.name,
      parent_id: f.parentId ? folderIds.get(f.parentId) : "0",
      ...(f.description !== undefined ? { description: f.description } : {}),
      ...(f.sort !== undefined ? { sort: f.sort } : {}),
    })),
    ...dictionary.map((m) => ({
      model_id: models.get(m.id),
      model_type: "model",
      name: m.name.slice(prefix.length),
      parent_id: m.folderId ? folderIds.get(m.folderId) : "0",
      ...(m.sort !== undefined ? { sort: m.sort } : {}),
      schema: rewrite(m.schema, m.id),
    })),
  ];
  const reverse = new Map([...models, ...folderIds].map(([a, b]) => [b, a]));
  const read = prepareApipostModels(
    native,
    (_kind, key) => reverse.get(key),
    project.name,
  );
  if (!isDeepStrictEqual(read.schemas, schemas)) fail("模型图回读不一致");
  const normalizedFolders = folders.map((f) => ({
    ...f,
    parentId: f.parentId || "",
    ...(!f.description ? {} : { description: f.description }),
  }));
  // Empty descriptions carry no extra native meaning; preserve populated metadata.
  for (const f of normalizedFolders)
    if (f.description === "") delete f.description;
  if (!isDeepStrictEqual(read.folders, normalizedFolders))
    fail("模型目录回读不一致");
  if (
    !isDeepStrictEqual(
      read.dictionary,
      dictionary.map((m) => {
        const c = { ...m };
        if (!c.folderId) delete c.folderId;
        return c;
      }),
    )
  )
    fail("模型定义回读不一致");
  return {
    models: native,
    rewrite(schema) {
      const value = rewrite(schema);
      if (!isDeepStrictEqual(read.rewrite(value), schema))
        fail("API模型引用回读不一致");
      return value;
    },
  };
}
