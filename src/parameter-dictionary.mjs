import { parseMySQLColumns } from "./mysql-ddl.mjs";
import { randomUUID } from "node:crypto";
const unsafe = new Set(["__proto__", "prototype", "constructor"]);
export function normalizeParameterEntry(input) {
  if (
    !input ||
    typeof input.key !== "string" ||
    !input.key.trim() ||
    input.key.length > 200 ||
    unsafe.has(input.key)
  )
    throw Error("字典参数名无效");
  const type = input.type || "string";
  if (
    !["string", "number", "integer", "boolean", "object", "array"].includes(
      type,
    )
  )
    throw Error("字典参数类型无效");
  if (input.enum !== undefined && !Array.isArray(input.enum))
    throw Error("枚举值必须是数组");
  return {
    id: input.id || randomUUID(),
    key: input.key.trim(),
    type,
    description: String(input.description || ""),
    note: String(input.note || ""),
    ...(input.default !== undefined ? { default: input.default } : {}),
    ...(input.example !== undefined ? { example: input.example } : {}),
    ...(input.enum !== undefined ? { enum: input.enum } : {}),
    ...(input.required !== undefined
      ? { required: input.required === true }
      : {}),
  };
}
export function parseParameterImport(source, format) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 1024 * 1024)
    throw Error("字典导入最多1MiB");
  if (format === "json") {
    const value = JSON.parse(source);
    if (Array.isArray(value)) return value.map(normalizeParameterEntry);
    if (!value || typeof value !== "object")
      throw Error("字典JSON必须为对象或数组");
    return Object.entries(value).map(([key, value]) =>
      normalizeParameterEntry(
        typeof value === "string"
          ? { key, description: value }
          : { key, ...value },
      ),
    );
  }
  if (format === "kv")
    return source
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith("//"))
      .map((line) => {
        const index = line.indexOf(":");
        if (index < 1) throw Error("key-value每行需要 参数名:说明");
        return normalizeParameterEntry({
          key: line.slice(0, index).trim(),
          description: line.slice(index + 1).trim(),
        });
      });
  if (format !== "mysql") throw Error("未知字典导入格式");
  return parseMySQLColumns(source).map(normalizeParameterEntry);
}
export function previewParameterImport(entries, existing = []) {
  const selected = new Map(),
    score = (entry) =>
      ["description", "note", "default", "example", "enum"].reduce(
        (total, key) =>
          total + (entry[key] !== undefined && entry[key] !== "" ? 1 : 0),
        0,
      );
  for (const input of entries) {
    const entry = normalizeParameterEntry({ ...input, id: randomUUID() }),
      identity = entry.key + "\0" + entry.type;
    if (!selected.has(identity) || score(entry) > score(selected.get(identity)))
      selected.set(identity, entry);
  }
  return [...selected.values()].map((entry) => ({
    entry,
    duplicate: existing.some(
      (old) => old.key === entry.key && old.type === entry.type,
    ),
  }));
}
