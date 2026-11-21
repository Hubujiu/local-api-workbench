import { isJsonResponseType } from "./response-media.js";
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

const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

export function editDesignResponseHeader(definition, source, name, header) {
  name = String(name).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
    throw Error("请输入有效的响应头名称");
  if (name.toLowerCase() === "content-type")
    throw Error("Content-Type 请在响应 Body 的媒体类型中设置");
  if (
    !record(definition) ||
    !record(header) ||
    (definition.headers !== undefined && !record(definition.headers))
  )
    throw Error("响应头定义必须是 JSON 对象");
  const headers = definition.headers || {};
  if (source !== null && !Object.hasOwn(headers, source))
    throw Error("响应头已不存在，请重新打开");
  if (
    Object.keys(headers).some(
      (key) => key !== source && key.toLowerCase() === name.toLowerCase(),
    )
  )
    throw Error("同名响应头已存在（不区分大小写）");
  const entries = Object.entries(headers).map(([key, value]) =>
    key === source ? [name, header] : [key, value],
  );
  if (source === null) entries.push([name, header]);
  return { ...definition, headers: Object.fromEntries(entries) };
}

export function headerEditorFields(name, header) {
  return `<label>响应头名称<input id="design-header-name" value="${esc(name)}" autocomplete="off"></label><label>响应头定义 JSON<textarea id="design-header-json" rows="10" spellcheck="false">${esc(JSON.stringify(header, null, 2))}</textarea></label>`;
}

function headerPreview(definition) {
  const headers = record(definition?.headers)
    ? Object.entries(definition.headers)
    : [];
  const rows = headers
    .map(([name, header]) => {
      const example = Object.hasOwn(header ?? {}, "example")
        ? JSON.stringify(header.example)
        : "";
      const type = header?.$ref
        ? "$ref"
        : Array.isArray(header?.schema?.type)
          ? header.schema.type.join(" | ")
          : header?.schema?.type || "";
      return `<tr><td><button type="button" class="ghost" data-response-header="${esc(name)}" aria-label="${esc("编辑响应头 " + name)}">${esc(name)}</button>${type ? ` <span class="design-response-kind">${esc(type)}</span>` : ""}</td><td>${esc(example)}</td><td>${esc(header?.description || "")}</td></tr>`;
    })
    .join("");
  const add =
    '<button type="button" class="ghost" id="new-response-header">＋ 添加响应头</button>';
  return `<table class="design-response-header-table"><thead><tr><th scope="col">参数名</th><th scope="col">示例值</th><th scope="col">描述</th></tr></thead><tbody>${rows || `<tr><td colspan="3">${add}</td></tr>`}</tbody></table>${rows ? add : ""}`;
}

export function exampleMedia(headers) {
  const types = Object.entries(headers || {}).filter(
    ([name]) => name.toLowerCase() === "content-type",
  );
  return types.length > 1 ? null : (types[0]?.[1] ?? "application/json");
}

export function scopedResponseExamples(examples, status, media) {
  return examples.flatMap((example, index) =>
    String(example?.status) === String(status) &&
    exampleMedia(example.headers) === media
      ? [{ example, index }]
      : [],
  );
}

export function supportsDesignExamples(definition, media, managed) {
  const status = String(definition?.status);
  const content = definition?.content?.[media];
  return (
    /^[1-5][0-9]{2}$/.test(status) &&
    isJsonResponseType(media) &&
    Boolean(content) &&
    (managed ||
      (!Object.hasOwn(content, "example") &&
        !Object.hasOwn(content, "examples")))
  );
}

function examplesPreview(definition, media, examples, managed) {
  if (!supportsDesignExamples(definition, media, managed))
    return '<p class="design-response-empty">此处只编辑具体状态及 JSON 媒体的工作台示例。其他示例请用 Mock 示例编辑器或响应定义 JSON。</p>';
  const rows = scopedResponseExamples(examples, definition.status, media);
  return `<div class="design-example-pane"><div class="design-example-bar"><button type="button" id="new-design-example" class="ghost">＋ 新建示例</button></div>${
    rows.length
      ? rows
          .map(
            ({ example, index }) =>
              `<div class="design-example-row"><button type="button" class="ghost" data-edit-design-example="${index}">${esc(example.name || "未命名示例")}</button><pre>${esc(example.body)}</pre></div>`,
          )
          .join("")
      : '<div class="design-example-empty"><span aria-hidden="true">1</span><p>当前状态和媒体类型还没有示例</p></div>'
  }</div>`;
}

export function designResponsePanel(
  definitions,
  selection,
  bindingNotice,
  examples = [],
) {
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
    )}</div><button id="new-response-schema" type="button" class="ghost">＋ 新建响应</button></div><div class="design-response-surface" id="design-response-selected"${index < 0 ? "" : ` role="tabpanel" aria-labelledby="design-response-${index}" tabindex="0"`}>${
    index < 0
      ? '<p class="design-response-empty">尚未定义响应。可新建响应或直接编辑 JSON。</p>'
      : `<div class="design-response-views" role="group" aria-label="响应定义视图">${[
          ["body", "Body"],
          ["headers", "Header"],
        ]
          .map(
            ([key, label]) =>
              `<button type="button" class="ghost" id="design-response-view-${key}" data-response-view="${key}" aria-pressed="${(selection?.view || "body") === key}">${label}</button>`,
          )
          .join("")}</div>${
          selection?.view === "headers"
            ? headerPreview(definition)
            : `<div class="design-response-tools"><div class="design-response-body-views" role="group" aria-label="Body 视图">${[
                ["schema", "数据结构"],
                ["examples", "示例"],
              ]
                .map(
                  ([key, label]) =>
                    `<button type="button" class="ghost" id="design-body-view-${key}" data-response-body-view="${key}" aria-pressed="${(selection?.bodyView || "schema") === key}">${label}</button>`,
                )
                .join(
                  "",
                )}</div>${mediaTypes.length > 1 ? `<label>Content-Type <select id="design-response-media" aria-label="响应 Content-Type">${mediaTypes.map((key) => `<option value="${esc(key)}" ${key === media ? "selected" : ""}>${esc(key)}</option>`).join("")}</select></label>` : media ? `<small>${esc(media)}</small>` : ""}${selection?.bodyView === "examples" ? "" : edit}</div>${selection?.bodyView === "examples" ? examplesPreview(definition, media, examples, bindingNotice) : schemaPreview(definition?.content?.[media]?.schema)}`
        }`
  }</div>${raw}</div>`;
}
