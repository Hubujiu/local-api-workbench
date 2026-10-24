// Static metadata parser. No SQL is sent to a database or evaluated.
function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    if (
      source[i] === "#" ||
      (source.slice(i, i + 2) === "--" && /\s/.test(source[i + 2] || " "))
    ) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.slice(i, i + 2) === "/*") {
      if (["!", "+"].includes(source[i + 2]))
        throw Error("不支持可执行DDL注释或提示");
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw Error("DDL注释不完整");
      i = end + 2;
      continue;
    }
    const start = i,
      quote = source[i];
    let kind, value;
    if (["'", '"', "`"].includes(quote)) {
      kind = quote === "`" ? "identifier" : "string";
      value = "";
      i++;
      let closed = false;
      while (i < source.length) {
        const c = source[i++];
        if (c === quote) {
          if (source[i] === quote) {
            value += quote;
            i++;
          } else {
            closed = true;
            break;
          }
        } else if (c === "\\" && quote !== "`") {
          if (i === source.length) break;
          const next = source[i++];
          const escapes = {
            0: "\0",
            b: "\b",
            n: "\n",
            r: "\r",
            t: "\t",
            Z: "\x1a",
          };
          value += Object.hasOwn(escapes, next)
            ? escapes[next]
            : ["%", "_"].includes(next)
              ? "\\" + next
              : next;
        } else value += c;
      }
      if (!closed) throw Error("DDL引号不完整");
    } else {
      const rest = source.slice(i);
      const number = rest.match(
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/,
      );
      const word = rest.match(/^[A-Za-z_$][\w$]*/);
      if (number) {
        kind = "number";
        value = number[0];
        i += value.length;
        if (/[A-Za-z_$]/.test(source[i] || ""))
          throw Error("无法解析DDL数字字面量");
      } else if (word) {
        kind = "word";
        value = word[0];
        i += value.length;
      } else {
        kind = "symbol";
        value = source[i++];
      }
    }
    tokens.push({ kind, value, start, end: i });
    if (tokens.length > 20000) throw Error("DDL最多20000个词元");
  }
  return tokens;
}
const word = (token, value) =>
  token?.kind === "word" && token.value.toUpperCase() === value;
function groupEnd(tokens, start) {
  if (tokens[start]?.value !== "(" || tokens[start]?.kind !== "symbol")
    throw Error("DDL需要括号");
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].kind !== "symbol") continue;
    if (tokens[i].value === "(" && ++depth > 32) throw Error("DDL括号最多32层");
    if (tokens[i].value === ")" && --depth === 0) return i;
  }
  throw Error("DDL括号不完整");
}
function split(tokens) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind === "symbol" && tokens[i].value === "(")
      i = groupEnd(tokens, i);
    else if (tokens[i].kind === "symbol" && tokens[i].value === ",") {
      parts.push(tokens.slice(start, i));
      start = i + 1;
    } else if (tokens[i].kind === "symbol" && tokens[i].value === ")")
      throw Error("DDL括号不匹配");
  }
  parts.push(tokens.slice(start));
  return parts;
}
function literal(tokens, type) {
  if (tokens.length && tokens.every((t) => t.kind === "string"))
    return { default: tokens.map((t) => t.value).join("") };
  if (tokens.length !== 1) return null;
  const t = tokens[0];
  if (word(t, "NULL")) return { default: null };
  if (t.kind === "number" || word(t, "TRUE") || word(t, "FALSE")) {
    const n = word(t, "TRUE") ? 1 : word(t, "FALSE") ? 0 : Number(t.value);
    if (
      !Number.isFinite(n) ||
      (Number.isInteger(n) && !Number.isSafeInteger(n))
    )
      throw Error("DDL默认数值超出JSON安全精度");
    if (type === "boolean")
      return n === 0 || n === 1 ? { default: n === 1 } : null;
    return { default: n };
  }
  return null;
}
const attributes = new Set([
  "NOT",
  "NULL",
  "COMMENT",
  "COLLATE",
  "CHARACTER",
  "AUTO_INCREMENT",
  "ON",
  "PRIMARY",
  "UNIQUE",
  "REFERENCES",
  "CHECK",
  "GENERATED",
  "STORED",
  "VIRTUAL",
  "INVISIBLE",
  "VISIBLE",
]);
export function parseMySQLColumns(source) {
  if (
    typeof source !== "string" ||
    new TextEncoder().encode(source).length > 1024 * 1024
  )
    throw Error("DDL输入最多1MiB文本");
  const tokens = tokenize(source);
  if (
    tokens.some(
      (t, index) =>
        t.kind === "symbol" && t.value === ";" && index !== tokens.length - 1,
    )
  )
    throw Error("仅支持单条CREATE TABLE");
  let at = 0;
  if (!word(tokens[at++], "CREATE") || !word(tokens[at++], "TABLE"))
    throw Error("仅支持单条CREATE TABLE字段定义，不执行SQL");
  if (word(tokens[at], "IF")) {
    if (!word(tokens[++at], "NOT") || !word(tokens[++at], "EXISTS"))
      throw Error("CREATE TABLE语法无效");
    at++;
  }
  const identifier = () => {
    if (!["word", "identifier"].includes(tokens[at]?.kind))
      throw Error("DDL表名无效");
    at++;
  };
  identifier();
  if (tokens[at]?.value === "." && tokens[at]?.kind === "symbol") {
    at++;
    identifier();
  }
  const end = groupEnd(tokens, at),
    tail = tokens.slice(end + 1);
  if (tail.at(-1)?.kind === "symbol" && tail.at(-1).value === ";") tail.pop();
  if (
    tail.some(
      (t) =>
        (t.kind === "symbol" && t.value === ";") ||
        (t.kind === "word" &&
          /^(CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|SELECT)$/i.test(t.value)),
    )
  )
    throw Error("仅支持单条CREATE TABLE");
  if (
    tail.length &&
    ![
      "ENGINE",
      "DEFAULT",
      "CHARSET",
      "CHARACTER",
      "COLLATE",
      "COMMENT",
      "AUTO_INCREMENT",
      "ROW_FORMAT",
      "KEY_BLOCK_SIZE",
    ].some((k) => word(tail[0], k))
  )
    throw Error("未支持的DDL表选项");
  const entries = [];
  for (const column of split(tokens.slice(at + 1, end))) {
    if (
      column[0]?.kind === "word" &&
      /^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|CHECK|FULLTEXT|SPATIAL)$/i.test(
        column[0].value,
      )
    )
      continue;
    if (
      !["word", "identifier"].includes(column[0]?.kind) ||
      column[1]?.kind !== "word"
    )
      throw Error("无法解析DDL字段");
    const key = column[0].value,
      kind = column[1].value.toLowerCase();
    let cursor = 2,
      params = [];
    if (column[cursor]?.kind === "symbol" && column[cursor].value === "(") {
      const close = groupEnd(column, cursor);
      params = column.slice(cursor + 1, close);
      cursor = close + 1;
    }
    let type;
    if (/^(tinyint|smallint|mediumint|int|integer|bigint)$/.test(kind))
      type =
        kind === "tinyint" && params.length === 1 && params[0].value === "1"
          ? "boolean"
          : "integer";
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
    else throw Error("未支持的DDL字段类型: " + kind);
    const entry = { key, type, description: "", required: false };
    if (kind === "enum")
      entry.enum = split(params).map((part) => {
        if (!part.length || part.some((t) => t.kind !== "string"))
          throw Error("DDL枚举须为字符串字面量");
        return part.map((t) => t.value).join("");
      });
    for (let i = cursor; i < column.length; i++) {
      if (column[i].kind === "symbol" && column[i].value === "(") {
        i = groupEnd(column, i);
        continue;
      }
      if (word(column[i], "NOT") && word(column[i + 1], "NULL")) {
        entry.required = true;
        i++;
      } else if (word(column[i], "COMMENT")) {
        if (column[i + 1]?.kind !== "string")
          throw Error("DDL COMMENT须为字符串");
        entry.description = column[++i].value;
        while (column[i + 1]?.kind === "string")
          entry.description += column[++i].value;
      } else if (word(column[i], "DEFAULT")) {
        const first = ++i;
        if (
          column[first]?.kind === "word" &&
          attributes.has(column[first].value.toUpperCase()) &&
          !word(column[first], "NULL")
        )
          throw Error("DDL DEFAULT缺少值");
        let stop = first;
        while (stop < column.length) {
          if (
            stop > first &&
            column[stop].kind === "word" &&
            attributes.has(column[stop].value.toUpperCase())
          )
            break;
          if (column[stop].kind === "symbol" && column[stop].value === "(")
            stop = groupEnd(column, stop);
          stop++;
        }
        const value = literal(column.slice(first, stop), type);
        if (value) Object.assign(entry, value);
        else {
          if (first === stop) throw Error("DDL DEFAULT缺少值");
          entry.note =
            "默认表达式未求值: " +
            source
              .slice(column[first].start, column[stop - 1].end)
              .slice(0, 1000);
        }
        i = stop - 1;
      }
    }
    entries.push(entry);
    if (entries.length > 1000) throw Error("DDL最多1000个字段");
  }
  return entries;
}
