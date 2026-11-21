import { schemaRows } from "./schema-editor.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

export function responseSelection(definitions, selection = {}) {
  const index = definitions.findIndex(
    (entry) => entry && String(entry.status) === selection.status,
  );
  const current = index < 0 && definitions.length ? 0 : index;
  const definition = definitions[current];
  const mediaTypes = Object.keys(definition?.content || {});
  const media = mediaTypes.includes(selection.media)
    ? selection.media
    : mediaTypes[0];
  return { index: current, definition, media, mediaTypes };
}

function schemaPreview(schema) {
  if (schema === undefined)
    return '<p class="design-response-empty">此响应尚未定义 Body 结构。</p>';
  try {
    return (
      '<div class="design-response-tree">' +
      schemaRows(schema)
        .map((row, index) => {
          const node = row.schema;
          const kind = node?.$ref
            ? "$ref"
            : Array.isArray(node?.type)
              ? node.type.join(" | ")
              : (node?.type ??
                (typeof node === "boolean" ? String(node) : "未指定"));
          return `<div class="design-response-node"><span style="padding-inline-start:${Math.min(140, row.depth * 14)}px">${index === 0 ? "根节点" : esc(row.name)}</span><span class="design-response-kind">${esc(kind)}${row.required ? " <small>必填</small>" : ""}</span><span>${esc(node?.description || "")}</span></div>`;
        })
        .join("") +
      "</div>"
    );
  } catch {
    return '<p class="notice">此结构不能用图形视图显示，请在响应定义 JSON 中编辑。</p>';
  }
}

export function designResponsePanel(definitions, selection, bindingNotice) {
  const { index, definition, media, mediaTypes } = responseSelection(
    definitions,
    selection,
  );
  const edit =
    index < 0
      ? ""
      : `<button type="button" class="ghost" data-response-schema="${esc(JSON.stringify([index, media || "application/json"]))}">编辑结构</button>`;
  const raw = `<div class="design-response-json"><label for="response-definitions">响应定义 JSON</label>${bindingNotice ? '<p class="muted">可在此编辑 Schema。绑定示例请用示例编辑器；响应状态请用可视编辑按钮，避免导出冲突。</p>' : ""}<textarea id="response-definitions" spellcheck="false">${esc(JSON.stringify(definitions, null, 2))}</textarea></div>`;
  return `<div class="design-response-shell"><div class="design-response-bar"><div class="design-response-tabs" role="tablist" aria-label="响应状态">${definitions
    .map((item, i) => {
      const status = String(item?.status ?? "");
      const label = item?.description ? String(item.description) : "";
      return `<button type="button" role="tab" id="design-response-${i}" data-design-response="${i}" aria-controls="design-response-selected" aria-selected="${index === i}" tabindex="${index === i ? 0 : -1}">${label ? esc(label) + "（" + esc(status) + "）" : esc(status || "无效定义")}</button>`;
    })
    .join(
      "",
    )}</div><button id="new-response-schema" type="button" class="ghost">＋ 新建响应</button></div><div class="design-response-surface" id="design-response-selected"${index < 0 ? "" : ` role="tabpanel" aria-labelledby="design-response-${index}" tabindex="0"`}>${index < 0 ? '<p class="design-response-empty">尚未定义响应。可新建响应或直接编辑 JSON。</p>' : `<div class="design-response-tools"><span>Body · 数据结构</span>${mediaTypes.length > 1 ? `<label>Content-Type <select id="design-response-media" aria-label="响应 Content-Type">${mediaTypes.map((key) => `<option value="${esc(key)}" ${key === media ? "selected" : ""}>${esc(key)}</option>`).join("")}</select></label>` : media ? `<small>${esc(media)}</small>` : ""}${edit}</div>${schemaPreview(definition?.content?.[media]?.schema)}`}</div>${raw}</div>`;
}
