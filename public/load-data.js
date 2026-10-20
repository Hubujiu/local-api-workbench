// Shared, deterministic parser. This module performs no I/O or expression evaluation.
export function parseLoadCSV(text = "") {
  if (typeof text !== "string") throw Error("压测CSV必须为文本");
  if (new TextEncoder().encode(text).length > 65536)
    throw Error("压测CSV超过64 KiB");
  text = text.replace(/^\uFEFF/, "");
  if (!text.trim()) return [];
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    closed = false,
    started = false;
  const cell = () => {
    row.push(field);
    if (row.length > 50) throw Error("压测CSV最多50列");
    field = "";
    closed = false;
    started = false;
  };
  const line = () => {
    cell();
    rows.push(row);
    row = [];
    if (rows.length > 101) throw Error("压测CSV最多100行数据");
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (c === ",") {
      cell();
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      line();
      continue;
    }
    if (closed) throw Error("压测CSV引号后只能为分隔符或换行");
    if (c === '"') {
      if (started) throw Error("压测CSV未转义引号");
      quoted = true;
      started = true;
      continue;
    }
    started = true;
    field += c;
  }
  if (quoted) throw Error("压测CSV引号未闭合");
  if (started || closed || row.length) line();
  if (rows.length < 2) throw Error("压测CSV须含表头及至少一行数据");
  const headers = rows.shift().map((x) => x.trim());
  if (
    headers.some(
      (x) =>
        !x ||
        x.length > 200 ||
        /[\r\n]/.test(x) ||
        ["__proto__", "constructor", "prototype"].includes(x),
    ) ||
    new Set(headers).size !== headers.length
  )
    throw Error("压测CSV变量名为空、重复或无效");
  return rows.map((values, i) => {
    if (values.length !== headers.length)
      throw Error("压测CSV第" + (i + 2) + "行列数与表头不同");
    return Object.fromEntries(headers.map((name, j) => [name, values[j]]));
  });
}
