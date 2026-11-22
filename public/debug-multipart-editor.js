import { formFileRepresentation } from "./form-field-types.js";
import { debugPairFromKey } from "./debug-pair-composer.js";

export const isDebugMultipart = (page, mode, param, bodyType) =>
  page === "apis" &&
  mode === "debug" &&
  param === "body" &&
  bodyType === "form-data";

export const newMultipartTextRow = (key) => {
  const row = debugPairFromKey(key);
  return row && { ...row, type: "text" };
};

export function multipartSelection(rows) {
  const checked = rows.filter(({ enabled }) => enabled !== false).length;
  return {
    disabled: rows.length === 0,
    checked: checked > 0 && checked === rows.length,
    indeterminate: checked > 0 && checked < rows.length,
  };
}

export function syncMultipartAll(control, rows) {
  if (control) Object.assign(control, multipartSelection(rows));
}

export function debugMultipartEditor(rows, esc) {
  const all = multipartSelection(rows);
  const automatic = "自动（content-type）";
  const storedRows = rows
    .map((row, i) => {
      const file = formFileRepresentation(row);
      const value =
        file && row.type !== "file"
          ? '<span class="muted">文件数据未作为文本显示；如需文本，请转换字段。</span>'
          : file
            ? `<label class="debug-multipart-file"><input type="file" data-field-file="${i}" aria-label="选择参数文件"><span>${esc(row.filename || "请选择文件")}</span></label>`
            : `<input data-pair="form:${i}:value" aria-label="参数值" value="${esc(row.value)}">`;
      return `<tr data-multipart-row="${i}">
      <td class="debug-multipart-check"><input type="checkbox" data-pair-enabled="form:${i}" ${row.enabled !== false ? "checked" : ""} aria-label="启用参数"></td>
      <td><div class="debug-multipart-name"><input data-pair="form:${i}:key" aria-label="参数名" value="${esc(row.key)}"><select data-field-type="${i}" aria-label="字段类型"><option value="text"${file ? "" : " selected"}>string</option><option value="file"${file ? " selected" : ""}>file</option></select></div></td>
      <td>${value}</td>
      <td class="debug-multipart-media" title="${esc(row.contentType || automatic)}">${esc(row.contentType || automatic)}</td>
      <td><div class="pair-row-actions"><button type="button" data-dynamic-pair="form:${i}">${row.dynamic ? "动态✓" : "动态"}</button><button type="button" data-dictionary-pair="form:${i}">字典</button><button type="button" data-define-pair="form:${i}" title="参数类型、必填与说明">定义</button><button type="button" data-remove-pair="form:${i}" aria-label="删除参数">×</button></div></td>
    </tr>`;
    })
    .join("");
  return `<section class="debug-multipart-editor" aria-label="multipart 表单">
    <div class="debug-multipart-scroll" tabindex="0" role="region" aria-label="表单参数，可横向滚动">
    <table class="debug-multipart-table" aria-label="multipart 参数">
      <colgroup><col class="debug-multipart-check-column"><col class="debug-multipart-name-column"><col class="debug-multipart-value-column"><col class="debug-multipart-media-column"><col></colgroup>
      <thead><tr><th scope="col" class="debug-multipart-check"><input id="debug-multipart-enable-all" type="checkbox" aria-label="启用全部表单参数"${all.checked ? " checked" : ""}${all.disabled ? " disabled" : ""}></th><th scope="col">参数名</th><th scope="col">参数值</th><th scope="col">内容类型</th><th scope="col">操作</th></tr></thead>
      <tbody>${storedRows}<tr class="debug-multipart-composer">
        <td class="debug-multipart-check"><button type="button" class="ghost" data-add-pair="form" aria-label="添加表单参数" title="添加表单参数">＋</button></td>
        <td><div class="debug-multipart-name"><input id="debug-multipart-new-key" type="text" aria-label="新表单参数名" autocomplete="off" spellcheck="false"><span class="debug-multipart-new-type">string</span></div></td>
        <td></td><td class="debug-multipart-media">${automatic}</td><td></td>
      </tr></tbody>
    </table></div>
    <div class="debug-multipart-tools"><button type="button" id="generate-body" class="ghost">基于数据结构生成 JSON</button></div>
  </section>`;
}
