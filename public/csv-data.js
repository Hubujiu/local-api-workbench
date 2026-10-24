// Pure bounded parser used by the UI load-data adapter and the isolated script VM.
export function parseCSVRows(text, maxRows = 1000, maxColumns = 100) {
  if (typeof text !== "string") throw Error("CSV必须为文本");
  let bytes = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    bytes += cp <= 127 ? 1 : cp <= 2047 ? 2 : cp <= 65535 ? 3 : 4;
    if (bytes > 65536) throw Error("CSV超过64 KiB");
  }
  text = text.replace(/^\uFEFF/, "");
  if (!text) return [];
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    closed = false,
    started = false;
  const cell = () => {
    row.push(field);
    if (row.length > maxColumns) throw Error("CSV最多" + maxColumns + "列");
    field = "";
    closed = false;
    started = false;
  };
  const line = () => {
    cell();
    rows.push(row);
    row = [];
    if (rows.length > maxRows) throw Error("CSV行数超过上限");
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
    if (closed) throw Error("CSV引号后只能为分隔符或换行");
    if (c === '"') {
      if (started) throw Error("CSV未转义引号");
      quoted = true;
      started = true;
      continue;
    }
    started = true;
    field += c;
  }
  if (quoted) throw Error("CSV引号未闭合");
  if (started || closed || row.length) line();
  return rows;
}
