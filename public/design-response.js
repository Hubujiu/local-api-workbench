import { validateMockResponse } from "./response-example.js";
import { isJsonResponseType } from "./response-media.js";
import {
  addSchemaProperty,
  editSchemaNode,
  schemaRows,
  schemaTypes,
} from "./schema-editor.js";

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

const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

function editableRoot(schema) {
  return (
    record(schema) &&
    !Object.hasOwn(schema, "$ref") &&
    !Object.hasOwn(schema, "$dynamicRef") &&
    !Object.hasOwn(schema, "$recursiveRef")
  );
}

const rootTypeMetadata = new Set([
  "type",
  "description",
  "title",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

const quickRootTypes = schemaTypes.filter(
  (type) => type !== "array" && type !== "null",
);

function simpleRootType(schema, content) {
  return (
    (schema.type === undefined || schemaTypes.includes(schema.type)) &&
    !Object.hasOwn(content, "example") &&
    !Object.hasOwn(content, "examples") &&
    Object.entries(schema).every(
      ([key, value]) =>
        rootTypeMetadata.has(key) ||
        (key === "properties" && record(value) && !Object.keys(value).length) ||
        (key === "required" && Array.isArray(value) && !value.length),
    )
  );
}

export function editDesignResponseRoot(definition, media, action, value) {
  const content = definition?.content;
  if (
    !media ||
    !record(content) ||
    !Object.hasOwn(content, media) ||
    !record(content[media]) ||
    !editableRoot(content[media].schema)
  )
    throw Error("当前状态或媒体类型没有可编辑的 Schema 根节点");
  const entry = content[media];
  const original = entry.schema;
  let schema;
  if (action === "description") {
    if (value === (original.description ?? "")) return definition;
    schema = editSchemaNode(original, [], { description: value });
  } else if (action === "type") {
    if (value === original.type || (!value && original.type === undefined))
      return definition;
    if (!simpleRootType(original, entry) || !quickRootTypes.includes(value))
      throw Error(
        "此根类型变更可能影响现有字段、约束或示例，请使用响应定义 JSON",
      );
    schema = editSchemaNode(original, [], { type: value });
  } else if (action === "add") {
    if (original.type !== "object") throw Error("只有对象根节点可以添加字段");
    schema = addSchemaProperty(original, [], value);
  } else {
    throw Error("不支持的 Schema 根节点操作");
  }
  return {
    ...definition,
    content: { ...content, [media]: { ...entry, schema } },
  };
}

function schemaKind(node) {
  return node?.$ref
    ? "$ref"
    : Array.isArray(node?.type)
      ? node.type.join(" | ")
      : (node?.type ?? (typeof node === "boolean" ? String(node) : "未指定"));
}

export function responseRootTypeFields(schema) {
  return `<label for="design-response-root-type-value">根类型</label><select id="design-response-root-type-value">${schema.type === undefined ? '<option value="">未指定</option>' : ""}${schemaTypes
    .filter((type) => type === schema.type || quickRootTypes.includes(type))
    .map(
      (type) =>
        `<option${schema.type === type ? " selected" : ""}>${type}</option>`,
    )
    .join("")}</select>`;
}

function schemaPreview(definition, index, media, collapsed, hasExamples) {
  const entry = definition?.content?.[media];
  const schema = entry?.schema;
  if (schema === undefined)
    return '<p class="design-response-empty">此响应尚未定义 Body 结构。</p>';
  try {
    const children = schemaRows(schema).slice(1);
    const editable = editableRoot(schema);
    const scope = esc(
      JSON.stringify([index, String(definition.status), media]),
    );
    const kind = schemaKind(schema);
    const description = schema?.description || "";
    const title = children.length
      ? `<button type="button" class="ghost" id="design-response-root-toggle" aria-label="根节点" aria-controls="design-response-root-children" aria-expanded="${!collapsed}"><span aria-hidden="true"></span>根节点</button>`
      : '<span class="design-response-root-label">根节点</span>';
    const type =
      editable && !hasExamples && simpleRootType(schema, entry)
        ? `<button type="button" class="ghost design-response-root-type" id="design-response-root-type" aria-label="编辑根节点类型：${esc(kind)}">${esc(kind)}</button>`
        : `<span class="design-response-kind">${esc(kind)}</span>`;
    const add =
      editable && schema.type === "object"
        ? '<button type="button" class="ghost design-response-root-add" id="design-response-root-add" aria-label="添加根字段">＋</button>'
        : "";
    return `<div class="design-response-tree" data-design-response-root="${scope}"><div class="design-response-node design-response-root">${title}<span class="design-response-root-actions">${add}${type}</span>${
      editable
        ? `<button type="button" class="ghost design-response-root-description${description ? "" : " muted"}" id="design-response-root-description" aria-label="编辑根节点描述" aria-expanded="false" aria-controls="design-response-root-form">${esc(description || "描述")}</button>`
        : `<span>${esc(description)}</span>`
    }</div>${
      editable
        ? `<form id="design-response-root-form" hidden><label for="design-response-root-description-value">根节点描述</label><textarea id="design-response-root-description-value" aria-describedby="design-response-root-description-note" rows="2" maxlength="8192" spellcheck="false">${esc(description)}</textarea><small class="muted" id="design-response-root-description-note">切换响应前，请先应用描述。</small><div class="design-response-root-form-actions"><button type="submit">应用到草稿</button><button type="button" class="ghost" id="design-response-root-cancel">取消</button></div></form>`
        : ""
    }<div id="design-response-root-children"${collapsed ? " hidden" : ""}>${children
      .map(
        (row) =>
          `<div class="design-response-node"><span style="padding-inline-start:${Math.min(140, row.depth * 14)}px">${esc(row.name)}</span><span class="design-response-kind">${esc(schemaKind(row.schema))}${row.required ? " <small>必填</small>" : ""}</span><span>${esc(row.schema?.description || "")}</span></div>`,
      )
      .join("")}</div></div>`;
  } catch {
    return '<p class="notice">此结构不能用图形视图显示，请在响应定义 JSON 中编辑。</p>';
  }
}

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

export function addDesignResponseStringHeader(
  definition,
  { name, example = "", description = "" },
) {
  if (
    typeof name !== "string" ||
    name.length > 256 ||
    typeof example !== "string" ||
    example.length > 8192 ||
    typeof description !== "string" ||
    description.length > 8192
  )
    throw Error("字符串响应头的名称、示例值或描述无效");
  const header = { schema: { type: "string" } };
  if (example !== "") header.example = example;
  if (description !== "") header.description = description;
  return editDesignResponseHeader(definition, null, name, header);
}

function headerPreview(definition, index, draft) {
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
  const pending =
    draft?.kind === "header" &&
    draft.index === index &&
    draft.status === String(definition.status)
      ? draft
      : null;
  const add =
    '<button type="button" class="ghost" id="new-response-header">使用 JSON 添加响应头</button>';
  const input = (key, label, maxlength) =>
    `<td><input form="design-response-header-form" id="design-new-header-${key}" aria-label="${label}" placeholder="${label}" autocomplete="off" spellcheck="false" maxlength="${maxlength}" value="${esc(pending?.[key] ?? "")}"></td>`;
  return `<table class="design-response-header-table"><thead><tr><th scope="col">参数名</th><th scope="col">示例值</th><th scope="col">描述</th></tr></thead><tbody>${rows}<tr class="design-response-header-composer">${input("name", "响应头名称", 256)}${input("example", "示例值", 8192)}${input("description", "描述", 8192)}</tr></tbody></table><form id="design-response-header-form" aria-label="新增字符串响应头"><div class="design-response-header-actions">${add}<button type="button" class="ghost" id="design-new-header-cancel"${pending ? "" : " disabled"}>取消</button><button class="primary" type="submit" id="design-new-header-apply"${pending?.name?.trim() ? "" : " disabled"}>添加到草稿</button></div></form>`;
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

export function designExampleTarget(rows, choice) {
  if (choice === "new" || !rows.length) return { key: "new" };
  const picked =
    rows.find(({ example }) => example === choice) ||
    (rows.length === 1 ? rows[0] : null);
  return picked ? { ...picked, key: String(picked.index) } : { key: "" };
}

export function prepareDesignExampleBody(
  definition,
  media,
  managed,
  example,
  body,
) {
  if (
    !supportsDesignExamples(definition, media, managed) ||
    (example &&
      (String(example.status) !== String(definition.status) ||
        exampleMedia(example.headers) !== media))
  )
    throw Error("示例不属于当前响应状态和媒体类型");
  const next = {
    ...(example || {
      name: "响应示例",
      status: Number(definition.status),
      headers: { "content-type": media },
    }),
    body,
  };
  validateMockResponse(next, { allowInformational: true });
  try {
    JSON.parse(body);
  } catch {
    throw Error("JSON 响应示例正文无效");
  }
  return next;
}

function examplesPreview(
  definition,
  index,
  media,
  examples,
  managed,
  choice,
  draft,
) {
  if (!supportsDesignExamples(definition, media, managed))
    return '<p class="design-response-empty">此处只编辑具体状态及 JSON 媒体的工作台示例。其他示例请用 Mock 示例编辑器或响应定义 JSON。</p>';
  const rows = scopedResponseExamples(examples, definition.status, media);
  const target = designExampleTarget(rows, choice);
  const pending =
    draft?.kind === "example" &&
    draft.definitionIndex === index &&
    draft.status === String(definition.status) &&
    draft.media === media &&
    draft.example === target.example &&
    draft.exampleIndex === target.index
      ? draft
      : null;
  const picker = rows.length
    ? `<label>当前示例 <select id="design-inline-example-choice">${target.key ? "" : '<option value="" selected disabled>选择要编辑的示例</option>'}${rows
        .map(
          ({ example, index }, ordinal) =>
            `<option value="${index}"${target.key === String(index) ? " selected" : ""}>${ordinal + 1}. ${esc(example.name || "未命名示例")}</option>`,
        )
        .join(
          "",
        )}<option value="new"${target.key === "new" ? " selected" : ""}>新示例正文</option></select></label>`
    : "";
  const advanced = rows.length
    ? `<div class="design-example-advanced" role="group" aria-label="示例详细设置">${rows
        .map(
          ({ example, index }) =>
            `<button type="button" class="ghost" data-edit-design-example="${index}">${esc(example.name || "未命名示例")}</button>`,
        )
        .join("")}</div>`
    : "";
  const edit = target.key
    ? `<form id="design-inline-example-form" aria-label="行内响应示例"><div class="design-inline-example-editor"><div class="design-inline-example-gutter" aria-hidden="true">1</div><textarea id="design-inline-example-body" aria-label="JSON 示例正文" wrap="off" rows="7" spellcheck="false" autocomplete="off">
${esc(pending?.body ?? target.example?.body ?? "")}</textarea></div><div class="design-inline-example-actions">
      <button type="button" class="ghost" id="design-inline-example-cancel"${pending ? "" : " disabled"}>取消</button>
      <button type="submit" class="primary" id="design-inline-example-apply"${pending ? "" : " disabled"}>${target.example ? "应用示例正文" : "添加示例到草稿"}</button>
    </div></form>`
    : '<p class="design-response-empty">请选择一个真实示例，或写入新示例正文。</p>';
  return `<div class="design-example-pane"><div class="design-example-bar">${picker}<button type="button" id="new-design-example" class="ghost">＋ 新建示例</button></div>${edit}${advanced}</div>`;
}

function responseSettings(definition, index, mediaTypes, examples, draft) {
  const status = String(definition?.status || "");
  const pending =
    draft?.kind === "settings" &&
    draft.index === index &&
    draft.status === status
      ? draft
      : null;
  const delays = examples.filter((ex) => String(ex?.status) === status);
  const format = mediaTypes.length ? mediaTypes.join(" · ") : "未定义";
  return `<form id="design-response-settings-form" aria-label="响应定义设置">
    <div class="design-response-settings">
      <label for="design-settings-description">响应说明<textarea id="design-settings-description" maxlength="8192" rows="1">
${esc(pending?.description ?? definition?.description ?? "")}</textarea></label>
      <label for="design-settings-status">HTTP 状态<input id="design-settings-status" value="${esc(pending?.value ?? status)}" placeholder="200 / 4XX / default" autocomplete="off" spellcheck="false"></label>
      <div><span id="design-settings-format-label">内容格式</span><output aria-labelledby="design-settings-format-label">${esc(format)}</output></div>
      <div><span id="design-settings-delay-label">示例延迟</span><output aria-labelledby="design-settings-delay-label">${delays.length ? esc(delays.map((ex) => (ex.name || "未命名") + "：" + (ex.delayMs == null ? "未单独设置" : ex.delayMs + " ms")).join(" · ")) : "尚无响应示例"}</output></div>
    </div>
    <div class="design-response-settings-actions">
      <span class="muted">格式在 Body 中编辑；延迟属于各个 Mock 示例，不是 OpenAPI 响应定义。</span>
      <button type="button" id="design-settings-cancel" class="ghost"${pending ? "" : " disabled"}>取消</button>
      <button type="submit" id="design-settings-apply" class="primary"${pending ? "" : " disabled"}>应用响应设置</button>
    </div>
  </form>`;
}

export function designResponsePanel(
  definitions,
  selection,
  bindingNotice,
  examples = [],
  collapsedRootScopes = null,
  settingsDraft = null,
) {
  const { index, definition, media, mediaTypes } = responseSelection(
    definitions,
    selection,
  );
  const showingExamples = selection?.bodyView === "examples";
  const edit =
    index < 0
      ? ""
      : `<button type="button" class="ghost" data-response-schema="${esc(JSON.stringify([index, media || "application/json"]))}">编辑结构</button>`;
  const raw = `<div class="design-response-json"><label for="response-definitions">响应定义 JSON</label>${bindingNotice ? '<p class="muted">可在此编辑 Schema。绑定示例请用示例编辑器；响应状态请用可视编辑按钮，避免导出冲突。</p>' : ""}<textarea id="response-definitions" spellcheck="false">
${esc(settingsDraft?.rawCurrent ?? JSON.stringify(definitions, null, 2))}</textarea></div>`;
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
          ["settings", "期望设置"],
        ]
          .map(
            ([key, label]) =>
              `<button type="button" class="ghost" id="design-response-view-${key}" data-response-view="${key}" aria-pressed="${(selection?.view || "body") === key}">${label}</button>`,
          )
          .join("")}</div>${
          selection?.view === "headers"
            ? headerPreview(definition, index, settingsDraft)
            : selection?.view === "settings"
              ? responseSettings(
                  definition,
                  index,
                  mediaTypes,
                  examples,
                  settingsDraft,
                )
              : `<div class="${showingExamples ? "" : "design-response-schema-pane"}"><div class="design-response-tools"><div class="design-response-body-views" role="group" aria-label="Body 视图">${[
                  ["schema", "数据结构"],
                  ["examples", "示例"],
                ]
                  .map(
                    ([key, label]) =>
                      `<button type="button" class="ghost" id="design-body-view-${key}" data-response-body-view="${key}" aria-pressed="${(selection?.bodyView || "schema") === key}">${label}</button>`,
                  )
                  .join(
                    "",
                  )}</div>${mediaTypes.length > 1 ? `<label>Content-Type <select id="design-response-media" aria-label="响应 Content-Type">${mediaTypes.map((key) => `<option value="${esc(key)}" ${key === media ? "selected" : ""}>${esc(key)}</option>`).join("")}</select></label>` : media ? `<small>${esc(media)}</small>` : ""}${showingExamples ? "" : edit}</div>${showingExamples ? examplesPreview(definition, index, media, examples, bindingNotice, selection?.exampleChoice, settingsDraft) : schemaPreview(definition, index, media, collapsedRootScopes?.has(JSON.stringify([String(definition?.status), media])), scopedResponseExamples(examples, definition.status, media).length > 0)}</div>`
        }`
  }</div>${raw}</div>`;
}
