export function ownsDebugPairComposer(kind, page, mode, parameter, request) {
  return (
    page === "apis" &&
    mode === "debug" &&
    kind === parameter &&
    (kind === "headers" ||
      kind === "query" ||
      (kind === "cookies" && request?.graphqlEditorVersion !== 1))
  );
}

export function debugPairFromKey(key) {
  if (typeof key !== "string" || !key.trim()) return null;
  return { key, value: "", enabled: true };
}

export function debugPairSelection(rows) {
  const enabled = rows.filter((row) => row.enabled !== false).length;
  return {
    checked: enabled === rows.length,
    indeterminate: enabled > 0 && enabled < rows.length,
    disabled: rows.length === 0,
  };
}

export const debugCookieSelection = debugPairSelection;
const headerNames = [
  "Accept",
  "Accept-Encoding",
  "Accept-Language",
  "Cache-Control",
  "Content-Type",
  "If-Match",
  "If-Modified-Since",
  "If-None-Match",
  "If-Unmodified-Since",
  "Range",
];
export const debugHeaderNameListHTML = () =>
  `<datalist id="debug-header-names">${headerNames.map((name) => `<option value="${name}"></option>`).join("")}</datalist>`;

export function debugPairComposer(kind, empty, ordinaryHeader = false) {
  if (kind === "headers" && ordinaryHeader)
    return '<tr class="debug-pair-composer"><td><div class="debug-header-name"><input type="checkbox" data-debug-header-next checked aria-label="启用新 Header 参数"><input type="text" data-debug-pair-name="headers" aria-label="新Header参数名" list="debug-header-names" autocomplete="off" spellcheck="false"></div></td><td></td><td><button type="button" class="ghost debug-pair-dictionary" data-debug-pair-dictionary="headers" title="从字典添加参数">字典</button></td></tr>';
  if (kind === "cookies")
    return '<tr class="debug-pair-composer"><td><div class="debug-cookie-name"><input type="checkbox" data-debug-cookie-next checked aria-label="启用新 Cookie 参数"><input type="text" data-debug-pair-name="cookies" aria-label="新 Cookie 参数名" autocomplete="off" spellcheck="false"></div></td><td></td><td><button type="button" class="ghost debug-pair-dictionary" data-debug-pair-dictionary="cookies" title="从字典添加参数">字典</button></td></tr>';
  const label = kind === "headers" ? "Header" : "Query";
  const add = `<button type="button" class="ghost" data-add-pair="${kind}" aria-label="添加${label}参数" title="添加参数">＋</button>`;
  const input = `<input type="text" data-debug-pair-name="${kind}" aria-label="新${label}参数名" autocomplete="off" spellcheck="false">`;
  const name = empty
    ? `<td><div class="debug-pair-compose-name">${add}${input}</div></td>`
    : `<td>${add}</td><td>${input}</td>`;
  return `<tr class="debug-pair-composer">${name}<td></td><td${empty ? "" : ' colspan="2"'}><button type="button" class="ghost debug-pair-dictionary" data-debug-pair-dictionary="${kind}" title="从字典添加参数">字典</button></td></tr>`;
}

export function debugQueryEqualityLabel(checked) {
  return checked
    ? "当参数值为空时，自动添加等号"
    : "当参数值为空时，不添加等号";
}

export function debugQueryEquality(value) {
  const checked = value !== false;
  return `<label class="debug-query-equality"><input id="query-add-equal" type="checkbox" ${checked ? "checked" : ""} title="${debugQueryEqualityLabel(checked)}" aria-label="空值 Query 参数添加等号" aria-describedby="debug-query-equality-scope"><span class="debug-query-equality-icon" aria-hidden="true">=</span><span id="debug-query-equality-scope" hidden>仅影响参数表中的空值；URL 内已有查询保持原样。</span></label>`;
}
