export function ownsDebugPairComposer(kind, page, mode, parameter) {
  return (
    page === "apis" &&
    mode === "debug" &&
    kind === parameter &&
    (kind === "headers" || kind === "query")
  );
}

export function debugPairFromKey(key) {
  if (typeof key !== "string" || !key.trim()) return null;
  return { key, value: "", enabled: true };
}

export function debugPairComposer(kind, empty) {
  const label = kind === "headers" ? "Header" : "Query";
  const add = `<button type="button" class="ghost" data-add-pair="${kind}" aria-label="添加${label}参数" title="添加参数">＋</button>`;
  const input = `<input type="text" data-debug-pair-name="${kind}" aria-label="新${label}参数名" autocomplete="off" spellcheck="false">`;
  const name = empty
    ? `<td><div class="debug-pair-compose-name">${add}${input}</div></td>`
    : `<td>${add}</td><td>${input}</td>`;
  return `<tr class="debug-pair-composer">${name}<td></td><td${empty ? "" : ' colspan="2"'}><button type="button" class="ghost debug-pair-dictionary" data-debug-pair-dictionary="${kind}" title="从字典添加参数">字典</button></td></tr>`;
}
