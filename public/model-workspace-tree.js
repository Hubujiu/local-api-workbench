import { addSchemaProperty, schemaRows } from "./schema-editor.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const typeOf = (schema) => {
  if (typeof schema === "boolean") return String(schema);
  if (typeof schema?.$ref === "string" && schema.$ref) return "$ref";
  const type = schema?.type;
  return typeof type === "string"
    ? type
    : (Array.isArray(type) &&
        type.filter((value) => typeof value === "string").join(" | ")) ||
        "未指定";
};

const describe = (schema) =>
  typeof schema?.description === "string" ? schema.description : "";

function readTree(schema) {
  try {
    const rows = schemaRows(schema).slice(1);
    const canAdd = Boolean(
      schema &&
        typeof schema === "object" &&
        !schema.$ref &&
        (!schema.type || schema.type === "object"),
    );
    return { rows, canAdd };
  } catch (error) {
    return { rows: [], canAdd: false, error: error.message };
  }
}

export class ModelWorkspaceTree {
  #pending = [];
  #sequence = 0;
  expanded = true;

  get pending() {
    return this.#pending;
  }

  get changed() {
    return this.#pending.some((field) => Boolean(field.name));
  }

  begin(schema, after) {
    const { canAdd } = readTree(schema);
    if (!canAdd) throw Error("当前根节点不能添加字段，请使用 Raw 编辑");
    if (this.#pending.length >= 20) throw Error("请先确认或取消已有字段");
    const index =
      after === undefined ? this.#pending.length : this.#index(after) + 1;
    const current = { id: String(++this.#sequence), name: "", error: "" };
    this.#pending.splice(index, 0, current);
    this.expanded = true;
    return current.id;
  }

  input(id, name) {
    const current = this.#pending[this.#index(id)];
    current.name = name;
  }

  cancel(id) {
    this.#pending.splice(this.#index(id), 1);
  }

  confirm(draft, id) {
    const current = this.#pending[this.#index(id)];
    try {
      draft.replaceSchema(addSchemaProperty(draft.schema, [], current.name));
      this.cancel(id);
      return true;
    } catch (error) {
      current.error = error.message;
      return false;
    }
  }

  assertResolved() {
    if (this.#pending.length) throw Error("请先确认或取消正在添加的字段");
  }

  #index(id) {
    const index = this.#pending.findIndex((field) => field.id === id);
    if (index < 0) throw Error("字段草稿已变化，请重新添加");
    return index;
  }
}

const plus = (attributes, label) =>
  `<button class="model-field-plus ghost" type="button" aria-label="${label}" title="${label}" ${attributes}><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor"><circle cx="8" cy="8" r="7"/><path d="M4.5 8h7M8 4.5v7"/></svg></button>`;

function fieldRow(row) {
  const depth = Math.min(row.depth, 8);
  return `<li class="model-tree-row model-schema-field" style="--model-field-depth:${depth}"><span class="model-field-name">${esc(row.name)}</span><span class="model-field-type"><span class="model-draft-type">${esc(typeOf(row.schema))}</span></span><span class="model-field-required">${row.required ? "必填" : ""}</span><span class="model-field-description muted">${esc(describe(row.schema))}</span></li>`;
}

function pendingRow(row) {
  const errorId = "model-field-error-" + row.id;
  return `<li class="model-tree-row model-pending-field" data-model-pending-field="${row.id}"><input id="model-field-name-${row.id}" data-model-field-name="${row.id}" aria-label="字段名称" placeholder="请输入字段名称" value="${esc(row.name)}" maxlength="200"${row.error ? ` aria-invalid="true" aria-describedby="${errorId}"` : ""}><span class="model-field-type">${plus(`data-model-field-sibling="${row.id}"`, "添加相邻字段")}</span><span class="model-pending-actions"><button class="ghost" type="button" data-model-field-confirm="${row.id}">确认字段</button><button class="ghost" type="button" data-model-field-cancel="${row.id}">取消字段</button></span>${row.error ? `<span class="model-field-error failed" id="${errorId}" role="alert">${esc(row.error)}</span>` : ""}</li>`;
}

export function modelWorkspaceTree(draft) {
  const tree = draft.tree;
  const { rows, canAdd, error } = readTree(draft.schema);
  return `<div class="model-tree-row model-draft-root"><button id="model-root-expand" class="ghost" type="button" aria-controls="model-tree-children" aria-expanded="${tree.expanded}"><span class="model-root-chevron" aria-hidden="true">›</span>根节点</button><span class="model-field-type">${canAdd ? plus('id="model-root-add"', "添加子级节点") : ""}<span class="model-draft-type">${esc(typeOf(draft.schema))}</span></span><span class="model-field-required"></span><span class="model-field-description muted">${esc(describe(draft.schema))}</span></div><ul id="model-tree-children" role="list" aria-label="模型字段"${tree.expanded ? "" : " hidden"}>${rows.map(fieldRow).join("")}${tree.pending.map(pendingRow).join("")}${error ? `<li class="model-tree-unavailable muted">请使用 Raw 编辑：${esc(error)}</li>` : ""}</ul>`;
}
