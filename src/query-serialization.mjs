const encodedPair = (key, value) =>
  new URLSearchParams([[String(key), String(value)]]).toString();
// Preserve literal URL query spelling instead of reserializing unrelated fields.
export function appendRequestQuery(url, rows, addEqual = true) {
  if (typeof addEqual !== "boolean") throw Error("Query等号选项必须为布尔值");
  const added = [];
  for (const row of rows.filter((row) => row.enabled !== false && row.key)) {
    const value = String(row.value ?? "");
    const pair = encodedPair(row.key, value);
    added.push(!addEqual && value === "" ? pair.slice(0, -1) : pair);
  }
  if (added.length)
    url.search =
      (url.search ? url.search.slice(1) + "&" : "") + added.join("&");
  return url;
}
function replaceURLQuery(url, name, replacement) {
  const rows = url.search ? url.search.slice(1).split("&") : [];
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

export function setURLQuery(url, name, value) {
  return replaceURLQuery(url, String(name), encodedPair(name, value));
}
// Explicit native-import compatibility. Do not change ordinary API-key encoding.
export function setAPIKeyQuery(url, auth) {
  if (auth.queryEncoding === undefined)
    return setURLQuery(url, auth.key, auth.value);
  if (auth.queryEncoding !== "apipost") throw Error("不支持的API Key查询编码");
  const name = String(auth.key ?? ""),
    value = String(auth.value ?? "");
  if (!/^[A-Za-z0-9_.~-]+$/.test(name) || /[&#\x00-\x1f\x7f]/.test(value))
    throw Error("原版API Key查询模式不支持分隔符、控制字符或复杂键名");
  // URL.search retains literal + and existing percent escapes, but encodes spaces.
  return replaceURLQuery(url, name, name + "=" + value);
}
