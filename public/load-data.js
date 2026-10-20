import { parseCSVRows } from "./csv-data.js";
// Adds the load-test-only header and data-shape contract to the shared parser.
export function parseLoadCSV(text = "") {
  if (typeof text !== "string") throw Error("压测CSV必须为文本");
  if (new TextEncoder().encode(text).length > 65536)
    throw Error("压测CSV超过64 KiB");
  if (!text.trim()) return [];
  let rows;
  try {
    rows = parseCSVRows(text, 101, 50);
  } catch (error) {
    if (error.message === "CSV行数超过上限")
      throw Error("压测CSV最多100行数据");
    throw error;
  }
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
