import { formFileRepresentation } from "./form-field-types.js";
import {
  debugFormRowActions,
  multipartSelection,
} from "./debug-multipart-editor.js";

export const isDebugURLencoded = (page, mode, param, request) =>
  page === "apis" &&
  mode === "debug" &&
  param === "body" &&
  request?.bodyType === "urlencoded" &&
  !request.form.some(formFileRepresentation);

export function debugURLencodedEditor(rows, esc) {
  const all = multipartSelection(rows);
  return `<section class="debug-urlencoded-editor" aria-label="URLencoded 表单">
    <div class="debug-urlencoded-scroll" tabindex="0" role="region" aria-label="URLencoded 参数，可横向滚动">
      <table class="debug-urlencoded-table" aria-label="URLencoded 参数">
        <colgroup><col class="debug-urlencoded-check-col"><col class="debug-urlencoded-key-col"><col class="debug-urlencoded-value-col"><col><col class="debug-urlencoded-action-col"></colgroup>
        <thead><tr><th scope="col" class="debug-urlencoded-check"><input id="debug-urlencoded-enable-all" type="checkbox" aria-label="启用全部表单参数"${all.checked ? " checked" : ""}${all.disabled ? " disabled" : ""}></th><th scope="col">参数名</th><th scope="col">参数值</th><th scope="col">描述</th><th scope="col" class="debug-urlencoded-action">操作</th></tr></thead>
        <tbody>${rows
          .map(
            (row, i) => `<tr data-urlencoded-row="${i}">
              <td class="debug-urlencoded-check"><input type="checkbox" data-pair-enabled="form:${i}" ${row.enabled !== false ? "checked" : ""} aria-label="启用参数"></td>
              <td><input data-pair="form:${i}:key" aria-label="参数名" value="${esc(row.key)}"></td>
              <td><input data-pair="form:${i}:value" aria-label="参数值" value="${esc(row.value)}"></td>
              <td><span class="debug-urlencoded-description" title="${esc(row.description || "")}">${esc(row.description || "")}</span></td>
              <td class="debug-urlencoded-action">${debugFormRowActions(row, i)}</td>
            </tr>`,
          )
          .join("")}<tr class="debug-urlencoded-composer">
          <td class="debug-urlencoded-check"><button type="button" class="ghost" data-add-pair="form" aria-label="添加表单参数" title="添加表单参数">＋</button></td>
          <td><input id="debug-urlencoded-new-key" type="text" aria-label="新表单参数名" autocomplete="off" spellcheck="false"></td><td></td><td></td><td class="debug-urlencoded-action"></td>
        </tr></tbody>
      </table>
    </div>
    <div class="debug-multipart-tools"><button type="button" id="generate-body" class="ghost">基于数据结构生成 JSON</button></div>
  </section>`;
}
