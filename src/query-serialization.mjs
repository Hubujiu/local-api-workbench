import {
  hasQuerySerialization,
  encodeQueryArray,
  validateQueryArrayRequest,
} from "./openapi-query-arrays.mjs";
const encodedPair = (key, value) =>
  new URLSearchParams([[String(key), String(value)]]).toString();
// Preserve literal URL query spelling instead of reserializing unrelated fields.
export function appendRequestQuery(url, rows, addEqual = true) {
  if (typeof addEqual !== "boolean") throw Error("Query等号选项必须为布尔值");
  validateQueryArrayRequest({ query: rows });
  const added = [];
  for (const row of rows.filter((row) => row.enabled !== false && row.key)) {
    if (hasQuerySerialization(row)) {
      added.push(...encodeQueryArray(row));
      continue;
    }
    const value = String(row.value ?? "");
    const pair = encodedPair(row.key, value);
    added.push(!addEqual && value === "" ? pair.slice(0, -1) : pair);
  }
  if (added.length)
    url.search =
      (url.search ? url.search.slice(1) + "&" : "") + added.join("&");
  return url;
}
export function setURLQuery(url, name, value) {
  name = String(name);
  const replacement = encodedPair(name, value),
    rows = url.search ? url.search.slice(1).split("&") : [];
  let replaced = false;
  const result = [];
  for (const row of rows) {
    const key = new URLSearchParams(row).keys().next().value;
    if (key === name) {
      if (!replaced) result.push(replacement);
      replaced = true;
    } else result.push(row);
  }
  if (!replaced) result.push(replacement);
  url.search = result.join("&");
  return url;
}
