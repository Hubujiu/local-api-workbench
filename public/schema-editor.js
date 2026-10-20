import { schemaChildMode } from "./schema-positions.js";
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const types = [
  "string",
  "integer",
  "number",
  "boolean",
  "object",
  "array",
  "null",
];
const constraintFields = {
  minimum: "数值下限",
  maximum: "数值上限",
  multipleOf: "数值步长",
  minLength: "最短长度",
  maxLength: "最长长度",
  minItems: "最少数组项",
  maxItems: "最多数组项",
  minProperties: "最少属性数",
  maxProperties: "最多属性数",
  format: "格式",
  pattern: "正则表达式",
  enum: "枚举（JSON数组）",
};
function editConstraints(node, fields) {
  if (!object(fields)) throw Error("约束字段必须为对象");
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(constraintFields, key)) throw Error("未支持的约束字段");
    if (typeof value !== "string" || value.length > 65536)
      throw Error("约束输入无效或过长");
    if (!value.trim()) {
      delete node[key];
      continue;
    }
    if (key === "enum") {
      let values;
      try {
        values = JSON.parse(value);
      } catch {
        throw Error("枚举必须为JSON数组");
      }
      if (!Array.isArray(values) || !values.length || values.length > 100)
        throw Error("枚举须含1至100项");
      node[key] = values;
    } else if (["format", "pattern"].includes(key)) {
      if (value.length > 4096) throw Error("文本约束最多4096字符");
      node[key] = value;
    } else {
      const n = Number(value);
      if (
        !Number.isFinite(n) ||
        (key === "multipleOf" && n <= 0) ||
        (/Length$|Items$|Properties$/.test(key) &&
          (!Number.isSafeInteger(n) || n < 0))
      )
        throw Error("数值约束无效");
      node[key] = n;
    }
  }
  for (const [min, max] of [
    ["minimum", "maximum"],
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
    ["minProperties", "maxProperties"],
  ])
    if (
      (Object.hasOwn(fields, min) || Object.hasOwn(fields, max)) &&
      typeof node[min] === "number" &&
      typeof node[max] === "number" &&
      node[min] > node[max]
    )
      throw Error("约束下限不能大于上限");
}
function nodeAt(schema, path) {
  if (!Array.isArray(path) || path.length > 32) throw Error("结构路径无效");
  let node = schema;
  for (let i = 0; i < path.length; ) {
    if (!object(node)) throw Error("结构路径无效");
    if (
      path[i] === "properties" &&
      i + 1 < path.length &&
      object(node.properties) &&
      Object.hasOwn(node.properties, path[i + 1])
    ) {
      node = node.properties[path[i + 1]];
      i += 2;
    } else if (path[i] === "items" && object(node.items)) {
      node = node.items;
      i++;
    } else throw Error("结构路径无效");
  }
  return node;
}
function editable(node) {
  if (!object(node)) throw Error("布尔结构请用JSON高级编辑");
  if (node.$ref) throw Error("引用结构请用JSON高级编辑");
}
function name(value) {
  const text = String(value ?? "");
  if (!text.trim() || text.length > 200)
    throw Error("字段名不能为空且至多200字符");
  return text;
}
function checkReferences(schema, path) {
  const prefix =
    "#/" +
    path
      .map((key) => String(key).replace(/~/g, "~0").replace(/\//g, "~1"))
      .join("/");
  let visited = 0;
  const visit = (node, depth = 0, mode = "schema") => {
    if (depth > 64) throw Error("结构嵌套过深");
    if (!node || typeof node !== "object") return;
    if (++visited > 5000) throw Error("引用检查最多5000节点，请用JSON编辑");
    let reference = mode === "schema" ? node.$ref : undefined;
    if (typeof reference === "string") {
      try {
        reference = decodeURIComponent(reference);
      } catch {}
    }
    if (
      typeof reference === "string" &&
      (reference === prefix || reference.startsWith(prefix + "/"))
    )
      throw Error("此字段被本地引用使用，请先在JSON中更新引用");
    for (const [key, value] of Object.entries(node)) {
      const childMode = Array.isArray(node)
        ? mode === "list"
          ? "schema"
          : "literal"
        : mode === "schema"
          ? schemaChildMode(key, value)
          : mode === "map" || (mode === "dependencies" && !Array.isArray(value))
            ? "schema"
            : "literal";
      visit(value, depth + 1, childMode);
    }
  };
  visit(schema);
}
export function schemaRows(schema) {
  const rows = [];
  const walk = (node, path, label, required, depth) => {
    if (rows.length >= 500) throw Error("可视结构最多500节点");
    if (depth > 16) throw Error("可视结构最多16层");
    rows.push({ path, name: label, schema: node, required, depth });
    if (!object(node) || node.$ref) return;
    if (node.properties !== undefined && !object(node.properties))
      throw Error("properties必须是对象");
    if (
      node.required !== undefined &&
      (!Array.isArray(node.required) ||
        node.required.some((key) => typeof key !== "string"))
    )
      throw Error("required必须是字段名数组");
    for (const [key, value] of Object.entries(node.properties || {}))
      walk(
        value,
        [...path, "properties", key],
        key,
        (node.required || []).includes(key),
        depth + 1,
      );
    if (object(node.items))
      walk(node.items, [...path, "items"], "数组项", false, depth + 1);
  };
  walk(schema, [], "根结构", false, 0);
  return rows;
}
export function editSchemaNode(schema, path, fields) {
  const next = structuredClone(schema),
    node = nodeAt(next, path);
  editable(node);
  if (Object.hasOwn(fields, "constraints"))
    editConstraints(node, fields.constraints);
  if (fields.type) {
    if (!types.includes(fields.type)) throw Error("字段类型无效");
    node.type = fields.type;
    if (fields.type === "array" && !Object.hasOwn(node, "items"))
      node.items = { type: "string" };
  }
  if (Object.hasOwn(fields, "description")) {
    const text = String(fields.description);
    if (text.length > 8192) throw Error("说明最多8192字符");
    node.description = text;
  }
  if (Object.hasOwn(fields, "example")) {
    if (fields.example === "") delete node.example;
    else {
      try {
        node.example = JSON.parse(fields.example);
      } catch {
        throw Error("示例必须为有效JSON，字符串请加双引号");
      }
    }
  }
  if (path.length >= 2 && path.at(-2) === "properties") {
    const parent = nodeAt(next, path.slice(0, -2)),
      old = path.at(-1),
      key = Object.hasOwn(fields, "name") ? name(fields.name) : old;
    if (key !== old) {
      if (Object.hasOwn(parent.properties, key)) throw Error("字段已存在");
      checkReferences(schema, path);
      parent.properties = Object.fromEntries(
        Object.entries(parent.properties).map(([k, v]) => [
          k === old ? key : k,
          v,
        ]),
      );
    }
    if (Object.hasOwn(fields, "required") || key !== old) {
      const required = (parent.required || []).includes(old),
        desired = Object.hasOwn(fields, "required")
          ? fields.required
          : required;
      parent.required = (parent.required || []).filter(
        (k) => k !== old && k !== key,
      );
      if (desired) parent.required.push(key);
    }
  }
  schemaRows(next);
  return next;
}
export function addSchemaProperty(schema, path, key) {
  key = name(key);
  const next = structuredClone(schema),
    node = nodeAt(next, path);
  editable(node);
  if (node.type && node.type !== "object") throw Error("仅对象结构可添加字段");
  if (node.properties && !object(node.properties))
    throw Error("properties格式无效，请用JSON编辑");
  if (Object.hasOwn(node.properties || {}, key)) throw Error("字段已存在");
  node.type ??= "object";
  node.properties = Object.fromEntries([
    ...Object.entries(node.properties || {}),
    [key, { type: "string" }],
  ]);
  schemaRows(next);
  return next;
}
export function removeSchemaProperty(schema, path) {
  if (path.length < 2 || path.at(-2) !== "properties")
    throw Error("只能删除对象属性");
  checkReferences(schema, path);
  const serialized = JSON.stringify(nodeAt(schema, path));
  if (/"\$(?:id|anchor|dynamicAnchor)"\s*:/.test(serialized))
    throw Error("包含结构标识或锚点，请用JSON编辑删除");
  const next = structuredClone(schema),
    parent = nodeAt(next, path.slice(0, -2));
  editable(parent);
  nodeAt(next, path);
  parent.properties = Object.fromEntries(
    Object.entries(parent.properties).filter(([key]) => key !== path.at(-1)),
  );
  if (parent.required)
    parent.required = parent.required.filter((key) => key !== path.at(-1));
  return next;
}
export function schemaEditor(schema) {
  const rows = schemaRows(schema);
  return (
    '<p class="notice">编辑对象、数组及常见字段；原有约束保留。引用、组合条件等复杂结构仍可用JSON编辑。取消不会修改接口。</p><div class="schema-error failed" role="status"></div><div class="schema-layout"><div class="schema-tree"><table><thead><tr><th>字段</th><th>类型</th><th>必填</th><th>说明</th><th>操作</th></tr></thead><tbody>' +
    rows
      .map((row, index) => {
        const node = row.schema,
          type = object(node)
            ? node.$ref
              ? "$ref"
              : Array.isArray(node.type)
                ? node.type.join(" | ")
                : node.type || "未指定"
            : String(node);
        const canEdit = object(node) && !node.$ref,
          canAdd = canEdit && (!node.type || node.type === "object");
        return (
          '<tr><td style="padding-left:' +
          Math.min(160, row.depth * 14) +
          'px">' +
          esc(row.name) +
          "</td><td>" +
          esc(type) +
          "</td><td>" +
          (row.required ? "是" : "否") +
          "</td><td>" +
          esc(node?.description || "") +
          "</td><td>" +
          (canEdit
            ? '<button type="button" data-schema-edit="' +
              index +
              '">编辑</button>'
            : "") +
          (canAdd
            ? '<button type="button" data-schema-add="' +
              index +
              '">加字段</button>'
            : "") +
          (row.path.at(-2) === "properties"
            ? '<button type="button" data-schema-remove="' +
              index +
              '">删除</button>'
            : "") +
          "</td></tr>"
        );
      })
      .join("") +
    '</tbody></table></div><div class="schema-fields"></div></div>'
  );
}
export function bindSchemaEditor(container, schema) {
  let draft = structuredClone(schema),
    editing = null;
  const report = (fn) => {
    try {
      fn();
      container.querySelector(".schema-error").textContent = "";
    } catch (error) {
      container.querySelector(".schema-error").textContent = error.message;
    }
  };
  const readPending = () => {
    if (!editing) return draft;
    if (editing.add)
      return addSchemaProperty(
        draft,
        editing.path,
        container.querySelector("[data-schema-name]").value,
      );
    else
      return editSchemaNode(draft, editing.path, {
        name: container.querySelector("[data-schema-name]").value,
        type: container.querySelector("[data-schema-type]").value,
        description: container.querySelector("[data-schema-description]").value,
        example: container.querySelector("[data-schema-example]").value,
        required: container.querySelector("[data-schema-required]").checked,
        constraints: Object.fromEntries(
          [...container.querySelectorAll("[data-schema-constraint]")]
            .filter((input) => input.value !== input.defaultValue)
            .map((input) => [input.dataset.schemaConstraint, input.value]),
        ),
      });
  };
  const commit = () => {
    draft = readPending();
    editing = null;
  };
  const show = (row, add) => {
    if (editing) throw Error("请先应用或放弃当前字段编辑");
    editing = { path: row.path, add };
    const node = row.schema;
    container.querySelector(".schema-fields").innerHTML =
      "<h4>" +
      (add ? "添加字段" : "编辑字段") +
      '</h4><label>字段名称</label><input data-schema-name value="' +
      esc(add ? "" : row.name) +
      '" ' +
      (!add && row.path.at(-2) !== "properties" ? "disabled" : "") +
      ">" +
      (add
        ? ""
        : '<label>类型</label><select data-schema-type><option value="">保持现有类型</option>' +
          types
            .map(
              (type) =>
                "<option " +
                (node.type === type ? "selected" : "") +
                ">" +
                type +
                "</option>",
            )
            .join("") +
          '</select><label><input type="checkbox" data-schema-required ' +
          (row.required ? "checked" : "") +
          " " +
          (row.path.at(-2) !== "properties" ? "disabled" : "") +
          '>必填</label><label>说明</label><input data-schema-description value="' +
          esc(node.description || "") +
          '"><label>示例（JSON；留空清除）</label><textarea data-schema-example>' +
          esc(
            Object.hasOwn(node, "example") ? JSON.stringify(node.example) : "",
          ) +
          '</textarea><details class="schema-constraints"><summary>范围、格式与枚举</summary><p class="muted">留空清除；未显示的高级约束保持不变。正则仅保存，不在编辑器中执行。</p><div class="schema-constraint-grid">' +
          Object.entries(constraintFields)
            .map(
              ([key, label]) =>
                "<div><label>" +
                label +
                '</label><input data-schema-constraint="' +
                key +
                '" value="' +
                esc(
                  Object.hasOwn(node, key)
                    ? key === "enum"
                      ? JSON.stringify(node[key])
                      : String(node[key])
                    : "",
                ) +
                '"></div>',
            )
            .join("") +
          "</div></details>") +
      '<button type="button" data-schema-apply>应用字段</button><button type="button" data-schema-cancel>放弃字段编辑</button>';
    container.querySelector("[data-schema-apply]").onclick = () =>
      report(() => {
        commit();
        render();
      });
    container.querySelector("[data-schema-cancel]").onclick = () => {
      editing = null;
      render();
    };
    container.querySelector("[data-schema-name]").focus();
  };
  const render = () => {
    container.innerHTML = schemaEditor(draft);
    const rows = schemaRows(draft);
    for (const button of container.querySelectorAll("[data-schema-edit]"))
      button.onclick = () =>
        report(() => show(rows[Number(button.dataset.schemaEdit)], false));
    for (const button of container.querySelectorAll("[data-schema-add]"))
      button.onclick = () =>
        report(() => show(rows[Number(button.dataset.schemaAdd)], true));
    for (const button of container.querySelectorAll("[data-schema-remove]"))
      button.onclick = () =>
        report(() => {
          if (editing) throw Error("请先应用或放弃当前字段编辑");
          draft = removeSchemaProperty(
            draft,
            rows[Number(button.dataset.schemaRemove)].path,
          );
          render();
        });
  };
  render();
  return () => {
    const next = readPending();
    schemaRows(next);
    return structuredClone(next);
  };
}

export function editResponseDefinition(responses, index, fields) {
  if (
    !Array.isArray(responses) ||
    !Number.isInteger(index) ||
    index < -1 ||
    index >= responses.length
  )
    throw Error("响应索引无效");
  const status = String(fields.status).trim(),
    mediaType = String(fields.mediaType).trim();
  if (!/^(default|[1-5](?:[0-9]{2}|XX))$/.test(status))
    throw Error("响应状态须为100至599、1XX至5XX或default");
  if (!/^[a-zA-Z0-9!#$&^_.+*-]+\/[a-zA-Z0-9!#$&^_.+*-]+$/.test(mediaType))
    throw Error("Content-Type须为不含参数的类型/子类型");
  if (
    responses.some((item, i) => i !== index && String(item.status) === status)
  )
    throw Error("此响应状态已存在，请编辑已有响应");
  if (index === -1 && responses.length >= 100)
    throw Error("可视响应定义最多100项");
  schemaRows(fields.schema);
  const description = String(fields.description || "");
  if (description.length > 8192) throw Error("响应说明最多8192字符");
  const next = structuredClone(responses),
    item = index < 0 ? {} : next[index];
  if (item.content !== undefined && !object(item.content))
    throw Error("响应content格式无效，请先用JSON修正");
  if (
    item.content?.[mediaType] !== undefined &&
    !object(item.content[mediaType])
  )
    throw Error("响应媒体定义格式无效，请先用JSON修正");
  item.status = status;
  item.description = description;
  item.content = {
    ...item.content,
    [mediaType]: {
      ...item.content?.[mediaType],
      schema: structuredClone(fields.schema),
    },
  };
  if (index < 0) next.push(item);
  return next;
}
