// Use the already-published transport projection. It can coalesce duplicate
// wire lines; never split a scalar or infer an original casing or order.
export function httpResponseHeaderRows(response) {
  if (
    !Number.isInteger(response?.status) ||
    response.status < 100 ||
    response.status > 599
  )
    return null;
  const headers = response.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers))
    return null;
  const rows = [];
  for (const [name, value] of Object.entries(headers)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item !== "string") return null;
      rows.push([name, item]);
    }
  }
  return rows;
}

export function httpResponseHeadersHTML(rows, esc) {
  return `<div class="http-response-header-scroll" role="region" aria-label="响应头表格滚动区" tabindex="0"><table class="http-response-header-table" aria-label="网络响应头"><thead><tr><th scope="col">参数名</th><th scope="col">参数值</th></tr></thead><tbody>${
    rows.length
      ? rows
          .map(
            ([name, value]) =>
              `<tr><th scope="row">${esc(name)}</th><td>${esc(value)}</td></tr>`,
          )
          .join("")
      : '<tr><td colspan="2" class="http-response-header-empty">暂无响应头</td></tr>'
  }</tbody></table></div>`;
}
