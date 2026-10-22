import { xmlToValue } from "./xml-value.js";
import { parseMySQLColumns } from "./mysql-ddl.js";
// Pure local inference. An example demonstrates types, not requiredness or limits.
export function inferSchemaFromJSON(source) {
  if (typeof source !== "string") throw Error("JSON样例必须为文本");
  if (new TextEncoder().encode(source).length > 65536)
    throw Error("JSON样例最多64KiB UTF-8");
  let example;
  try {
    example = JSON.parse(source);
  } catch {
    throw Error("JSON样例格式无效");
  }
  let nodes = 0;
  function infer(value, depth) {
    if (++nodes > 2000 || depth > 20)
      throw Error("JSON样例最多2000个节点、20层嵌套");
    if (value === null) return { type: "null" };
    if (typeof value === "number") {
      if (
        !Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))
      )
        throw Error("JSON样例包含非有限数或不安全整数，请将精确大数改为字符串");
      return { type: Number.isInteger(value) ? "integer" : "number" };
    }
    if (typeof value === "string" || typeof value === "boolean")
      return { type: typeof value };
    if (Array.isArray(value)) {
      const variants = [],
        seen = new Set();
      for (const item of value) {
        const schema = infer(item, depth + 1),
          key = JSON.stringify(schema);
        if (!seen.has(key)) {
          seen.add(key);
          variants.push(schema);
        }
        if (variants.length > 16)
          throw Error("JSON数组最多16种不同结构，请先整理样例");
      }
      return {
        type: "array",
        items: variants.length > 1 ? { anyOf: variants } : variants[0] || {},
      };
    }
    const properties = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        infer(child, depth + 1),
      ]),
    );
    return { type: "object", properties };
  }
  return { ...infer(example, 0), example };
}

export function inferSchemaFromMySQL(source) {
  if (
    typeof source !== "string" ||
    new TextEncoder().encode(source).length > 65536
  )
    throw Error("模型DDL输入最多64KiB文本");
  const entries = parseMySQLColumns(source),
    names = new Set();
  if (!entries.length) throw Error("模型DDL至少需要一个字段");
  const properties = entries.map((entry) => {
    if (
      !entry.key ||
      entry.key.length > 200 ||
      ["__proto__", "prototype", "constructor"].includes(entry.key)
    )
      throw Error("模型DDL字段名无效");
    const identity = entry.key.toLowerCase();
    if (names.has(identity)) throw Error("模型DDL字段名重复");
    names.add(identity);
    const property = { type: entry.type };
    const notes = [
      entry.description,
      entry.note,
      entry.required ? "SQL NOT NULL（不自动标记API必填）" : "",
    ].filter(Boolean);
    if (entry.enum) property.enum = entry.enum;
    if (Object.hasOwn(entry, "default")) {
      const value = entry.default;
      if (value === null)
        notes.push("SQL默认NULL；未自动推断API可空性或生成默认值");
      else {
        const compatible =
          entry.type === "integer"
            ? Number.isSafeInteger(value)
            : entry.type === "object"
              ? typeof value === "object" && !Array.isArray(value)
              : typeof value === entry.type;
        if (!compatible)
          throw Error(
            "DDL默认值需要数据库类型转换，无法直接映射: " + entry.key,
          );
        if (entry.enum && !entry.enum.includes(value))
          throw Error("DDL默认值不在枚举中: " + entry.key);
        property.default = value;
      }
    }
    if (notes.length) property.description = notes.join("\n");
    return [entry.key, property];
  });
  return { type: "object", properties: Object.fromEntries(properties) };
}

export function inferSchemaFromXML(source, Parser = globalThis.DOMParser) {
  const value = xmlToValue(source, Parser);
  try {
    return inferSchemaFromJSON(JSON.stringify(value));
  } catch (error) {
    throw Error("XML转换后的JSON结构: " + error.message);
  }
}
