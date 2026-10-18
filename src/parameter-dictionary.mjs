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
function splitSQL(source) {
  const parts = [];
  let value = "",
    quote = "",
    depth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      value += c;
      if (c === "\\" && i + 1 < source.length) value += source[++i];
      else if (c === quote) {
        if (source[i + 1] === quote) value += source[++i];
        else quote = "";
      }
      continue;
    }
    if (["'", '"', "`"].includes(c)) {
      quote = c;
      value += c;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(value);
      value = "";
    } else value += c;
  }
  if (quote || depth !== 0) throw Error("DDL括号或引号不完整");
  if (value.trim()) parts.push(value);
  return parts;
}
function sqlString(value) {
  return value
    .slice(1, -1)
    .replace(/''/g, "'")
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
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
  const table = source.match(
    /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`[^`]+`|[\w.]+)\s*\(([\s\S]*)\)\s*(?:[^;]*)?;?\s*$/i,
  );
  if (!table) throw Error("仅支持单条CREATE TABLE字段定义，不执行SQL");
  const entries = [];
  for (const column of splitSQL(table[1])) {
    if (
      /^\s*(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|CHECK|FULLTEXT|SPATIAL)\b/i.test(
        column,
      )
    )
      continue;
    const match = column.match(
      /^\s*(?:`([^`]+)`|([A-Za-z_][\w$]*))\s+([A-Za-z]+)(?:\s*\(([^)]*)\))?([\s\S]*)$/,
    );
    if (!match) throw Error("无法解析DDL字段: " + column.slice(0, 80));
    const [, quoted, plain, sqlType, size, rest] = match,
      key = quoted || plain,
      kind = sqlType.toLowerCase();
    let type;
    if (/^(tinyint|smallint|mediumint|int|integer|bigint)$/.test(kind))
      type = kind === "tinyint" && size === "1" ? "boolean" : "integer";
    else if (/^(float|double|decimal|numeric|real)$/.test(kind))
      type = "number";
    else if (/^(bool|boolean)$/.test(kind)) type = "boolean";
    else if (kind === "json") type = "object";
    else if (
      /^(char|varchar|text|tinytext|mediumtext|longtext|date|datetime|timestamp|time|year|enum|set|binary|varbinary|blob|tinyblob|mediumblob|longblob)$/.test(
        kind,
      )
    )
      type = "string";
    else throw Error("未支持的DDL字段类型: " + sqlType);
    const description = rest.match(/COMMENT\s+('(?:\\.|''|[^'])*')/i);
    const entry = {
      key,
      type,
      description: description ? sqlString(description[1]) : "",
      required: /\bNOT\s+NULL\b/i.test(rest),
    };
    if (kind === "enum") {
      entry.enum = splitSQL(size || "").map(sqlString);
    }
    const defaultValue = rest.match(
      /\bDEFAULT\s+('(?:\\.|''|[^'])*'|-?\d+(?:\.\d+)?|NULL|TRUE|FALSE)/i,
    );
    if (defaultValue) {
      const value = defaultValue[1];
      entry.default = value.startsWith("'")
        ? sqlString(value)
        : /^null$/i.test(value)
          ? null
          : type === "boolean"
            ? value === "1" || /^true$/i.test(value)
            : Number(value);
    }
    entries.push(normalizeParameterEntry(entry));
  }
  return entries;
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
