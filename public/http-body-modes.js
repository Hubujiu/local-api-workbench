export const httpBodyFamilies = Object.freeze([
  "none",
  "form-data",
  "urlencoded",
  "binary",
  "msgpack",
  "raw",
]);

export const httpBodyFamily = (type) => (type === "json" ? "raw" : type);
export const httpBodyRadios = 'input[name="body-type"]';
export const compactHTTPBodySelector = "#http-split-body-family";

export function httpBodyModesHTML(
  type,
  { polish = false, compact = false } = {},
) {
  const family = httpBodyFamily(type);
  const supported = httpBodyFamilies.includes(family);
  return `<div class="body-types">${httpBodyFamilies
    .map(
      (mode) =>
        `<label><input type="radio" name="body-type" value="${mode}"${family === mode ? " checked" : ""}>${polish ? `<span class="body-type-caption" title="${mode}">${mode}</span>` : mode}</label>`,
    )
    .join(
      "",
    )}${compact ? `<select id="http-split-body-family" aria-label="请求正文类型"${supported ? "" : " disabled"}>${supported ? "" : '<option value="" selected>当前格式不受支持</option>'}${httpBodyFamilies.map((mode) => `<option value="${mode}"${family === mode ? " selected" : ""}>${mode}</option>`).join("")}</select>` : ""}${["json", "raw"].includes(type) ? `<select id="raw-format" aria-label="Raw格式"><option value="json"${type === "json" ? " selected" : ""}>JSON</option><option value="raw"${type === "raw" ? " selected" : ""}>Text</option></select>` : ""}</div>`;
}

export function focusHTTPBodyModeAfterLayout(editor, active, split) {
  if (!active || !editor.contains(active)) return;
  const compact = editor.querySelector(compactHTTPBodySelector);
  const bodyTab = () => editor.querySelector('[data-param="body"]');
  if (split && active.matches(httpBodyRadios))
    (compact?.disabled ? bodyTab() : compact)?.focus({ preventScroll: true });
  if (!split && active === compact)
    (editor.querySelector(httpBodyRadios + ":checked") || bodyTab())?.focus({
      preventScroll: true,
    });
}
