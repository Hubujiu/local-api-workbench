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
const combinations = ["allOf", "anyOf", "oneOf"];
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
    } else if (
      combinations.includes(path[i]) &&
      Array.isArray(node[path[i]]) &&
      Number.isInteger(path[i + 1]) &&
      Object.hasOwn(node[path[i]], path[i + 1])
    ) {
      node = node[path[i]][path[i + 1]];
      i += 2;
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
function visitSchemaPositions(schema, callback) {
  let visited = 0;
  const visit = (node, depth = 0, mode = "schema") => {
    if (depth > 64) throw Error("结构嵌套过深");
    if (!node || typeof node !== "object") return;
    if (++visited > 5000) throw Error("引用检查最多5000节点，请用JSON编辑");
    if (mode === "schema") callback(node);
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
function checkReferences(schema, path, { strictPointers = false } = {}) {
  const prefix =
    "#/" +
    path
      .map((key) => String(key).replace(/~/g, "~0").replace(/\//g, "~1"))
      .join("/");
  visitSchemaPositions(schema, (node) => {
    let reference = node.$ref;
    if (typeof reference === "string") {
      try {
        reference = decodeURIComponent(reference);
      } catch {}
    }
    if (
      strictPointers &&
      (Object.hasOwn(node, "$dynamicRef") ||
        Object.hasOwn(node, "$recursiveRef") ||
        (Object.hasOwn(node, "$ref") &&
          (typeof reference !== "string" ||
            (reference !== "#" && !reference.startsWith("#/")))))
    )
      throw Error("组合包含非本地Pointer或动态引用，请用JSON编辑");
    if (
      typeof reference === "string" &&
      (reference === prefix || reference.startsWith(prefix + "/"))
    )
      throw Error("此字段被本地引用使用，请先在JSON中更新引用");
  });
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
    for (const kind of combinations) {
      if (!Object.hasOwn(node, kind)) continue;
      if (
        !Array.isArray(node[kind]) ||
        !node[kind].length ||
        node[kind].length > 100
      )
        throw Error("组合须含1至100个分支");
      for (const [index, branch] of node[kind].entries()) {
        if (typeof branch !== "boolean" && !object(branch))
          throw Error("组合分支须为Schema对象或布尔值");
        walk(
          branch,
          [...path, kind, index],
          kind + " 分支 " + (index + 1),
          false,
          depth + 1,
        );
      }
    }
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
  checkIdentifiers(nodeAt(schema, path));
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
function checkIdentifiers(schema) {
  visitSchemaPositions(schema, (node) => {
    if (
      ["$id", "$anchor", "$dynamicAnchor"].some((key) =>
        Object.hasOwn(node, key),
      )
    )
      throw Error("包含结构标识或锚点，请用JSON编辑删除");
  });
}
export function addSchemaBranch(schema, path, kind, type) {
  if (!combinations.includes(kind)) throw Error("组合类型无效");
  if (!types.includes(type)) throw Error("分支类型无效");
  schemaRows(schema);
  const next = structuredClone(schema),
    node = nodeAt(next, path);
  editable(node);
  if ((node[kind]?.length || 0) >= 100) throw Error("组合最多100个分支");
  (node[kind] ??= []).push(
    type === "array" ? { type, items: { type: "string" } } : { type },
  );
  schemaRows(next);
  return next;
}
export function removeSchemaBranch(schema, path) {
  if (
    !Array.isArray(path) ||
    path.length < 2 ||
    !combinations.includes(path.at(-2)) ||
    !Number.isInteger(path.at(-1))
  )
    throw Error("组合分支路径无效");
  schemaRows(schema);
  const node = nodeAt(schema, path),
    parent = nodeAt(schema, path.slice(0, -2)),
    kind = path.at(-2);
  editable(parent);
  if (parent[kind].length <= 1)
    throw Error("组合至少保留一个分支；移除整个组合请用JSON编辑");
  checkReferences(schema, path.slice(0, -1), { strictPointers: true });
  checkIdentifiers(node);
  const next = structuredClone(schema);
  nodeAt(next, path.slice(0, -2))[kind].splice(path.at(-1), 1);
  schemaRows(next);
  return next;
}
export function editSchemaReference(schema, path, reference) {
  if (typeof reference !== "string" || reference.length > 4096)
    throw Error("引用须为至多4096字符的本地JSON Pointer");
  const next = structuredClone(schema),
    node = nodeAt(next, path);
  if (!object(node)) throw Error("布尔结构不能添加引用");
  if (!reference) {
    delete node.$ref;
    return next;
  }
  let pointer;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    throw Error("引用URI编码无效");
  }
  if (
    !reference.startsWith("#") ||
    (pointer && !pointer.startsWith("/")) ||
    /~(?:[^01]|$)/.test(pointer)
  )
    throw Error("仅支持当前结构内的JSON Pointer引用");
  const parts = pointer
    ? pointer
        .slice(1)
        .split("/")
        .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"))
    : [];
  if (
    parts.length > 32 ||
    parts.some((key) => ["__proto__", "constructor", "prototype"].includes(key))
  )
    throw Error("引用路径无效");
  let target = next,
    mode = "schema";
  for (const key of parts) {
    if (!target || typeof target !== "object" || !Object.hasOwn(target, key))
      throw Error("引用目标不存在");
    const value = target[key];
    mode = Array.isArray(target)
      ? mode === "list"
        ? "schema"
        : "literal"
      : mode === "schema"
        ? schemaChildMode(key, value)
        : mode === "map" || (mode === "dependencies" && !Array.isArray(value))
          ? "schema"
          : "literal";
    target = value;
  }
  if (mode !== "schema" || (typeof target !== "boolean" && !object(target)))
    throw Error("引用目标不是Schema位置");
  node.$ref = reference;
  return next;
}
export function schemaEditor(schema) {
  const rows = schemaRows(schema);
  return (
    '<p class="notice">编辑对象、数组、组合分支及常见字段；原有约束保留。支持当前结构内的JSON Pointer引用；其他高级结构仍可用JSON编辑。取消不会修改接口。</p><div class="schema-error failed" role="status"></div><div class="schema-layout"><div class="schema-tree"><table><thead><tr><th>字段</th><th>类型</th><th>必填</th><th>说明</th><th>操作</th></tr></thead><tbody>' +
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
          (object(node)
            ? '<button type="button" data-schema-reference-edit="' +
              index +
              '">引用</button>'
            : "") +
          (canAdd
            ? '<button type="button" data-schema-add="' +
              index +
              '">加字段</button>'
            : "") +
          (canEdit
            ? '<button type="button" data-schema-branch-add="' +
              index +
              '">组合</button>'
            : "") +
          (combinations.includes(row.path.at(-2))
            ? '<button type="button" data-schema-branch-remove="' +
              index +
              '">删分支</button>'
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
    if (editing.reference)
      return editSchemaReference(
        draft,
        editing.path,
        container.querySelector("[data-schema-reference]").value,
      );
    if (editing.branch)
      return addSchemaBranch(
        draft,
        editing.path,
        container.querySelector("[data-schema-combination]").value,
        container.querySelector("[data-schema-branch-type]").value,
      );
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
      '<div class="schema-field-content"><h4>' +
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
      '</div><div class="schema-field-actions"><button type="button" data-schema-apply>应用字段</button><button type="button" data-schema-cancel>放弃字段编辑</button></div>';
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
  const showBranch = (row) => {
    if (editing) throw Error("请先应用或放弃当前字段编辑");
    editing = { path: row.path, branch: true };
    container.querySelector(".schema-fields").innerHTML =
      '<div class="schema-field-content"><h4>添加组合分支</h4><p class="notice">保留当前节点的其他约束。allOf须全部满足；anyOf至少满足一个；oneOf恰好满足一个。新分支追加在末尾。</p><label for="schema-combination">组合规则</label><select id="schema-combination" data-schema-combination><option value="allOf">allOf · 全部满足</option><option value="anyOf">anyOf · 至少一个</option><option value="oneOf">oneOf · 恰好一个</option></select><label for="schema-branch-type">分支类型</label><select id="schema-branch-type" data-schema-branch-type>' +
      types.map((type) => "<option>" + type + "</option>").join("") +
      '</select></div><div class="schema-field-actions"><button type="button" data-schema-apply>添加分支</button><button type="button" data-schema-cancel>放弃分支编辑</button></div>';
    container.querySelector("[data-schema-apply]").onclick = () =>
      report(() => {
        commit();
        render();
      });
    container.querySelector("[data-schema-cancel]").onclick = () => {
      editing = null;
      render();
    };
    container.querySelector("[data-schema-combination]").focus();
  };
  const showReference = (row) => {
    if (editing) throw Error("请先应用或放弃当前字段编辑");
    editing = { path: row.path, reference: true };
    container.querySelector(".schema-fields").innerHTML =
      '<div class="schema-field-content"><h4>编辑本地引用</h4><p class="notice">仅引用当前结构中的Schema，例如 #/$defs/User。不会联网加载；其他字段和约束保持，留空解除引用。递归结构生成示例时仍需有限example。</p><label>JSON Pointer</label><input data-schema-reference value="' +
      esc(row.schema.$ref || "") +
      '"></div><div class="schema-field-actions"><button type="button" data-schema-apply>应用引用</button><button type="button" data-schema-cancel>放弃引用编辑</button></div>';
    container.querySelector("[data-schema-apply]").onclick = () =>
      report(() => {
        commit();
        render();
      });
    container.querySelector("[data-schema-cancel]").onclick = () => {
      editing = null;
      render();
    };
    container.querySelector("[data-schema-reference]").focus();
  };
  const render = () => {
    container.innerHTML = schemaEditor(draft);
    const rows = schemaRows(draft);
    for (const button of container.querySelectorAll("[data-schema-branch-add]"))
      button.onclick = () =>
        report(() => showBranch(rows[Number(button.dataset.schemaBranchAdd)]));
    for (const button of container.querySelectorAll(
      "[data-schema-branch-remove]",
    ))
      button.onclick = () =>
        report(() => {
          if (editing) throw Error("请先应用或放弃当前字段编辑");
          draft = removeSchemaBranch(
            draft,
            rows[Number(button.dataset.schemaBranchRemove)].path,
          );
          render();
        });
    for (const button of container.querySelectorAll(
      "[data-schema-reference-edit]",
    ))
      button.onclick = () =>
        report(() =>
          showReference(rows[Number(button.dataset.schemaReferenceEdit)]),
        );
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

export function editRequestResponseDefinition(request, index, fields) {
  const oldStatus = request.responses?.[index]?.status;
  const responses = editResponseDefinition(
    request.responses || [],
    index,
    fields,
  );
  const status = responses[index < 0 ? responses.length - 1 : index].status;
  const update = { responses };
  if (
    request.openapiExampleBindingsVersion !== 1 ||
    index < 0 ||
    String(oldStatus) === status
  )
    return update;
  const sources = request.openapiExampleSources || [];
  if (
    sources.some((source) => String(source.status) === String(oldStatus)) &&
    !/^[1-5]\d\d$/.test(status)
  )
    throw Error("含绑定示例的响应只能改为具体状态码，请先处理这些示例");
  const move = (source) =>
    source && String(source.status) === String(oldStatus)
      ? { ...source, status }
      : source;
  update.openapiExampleSources = sources.map(move);
  update.examples = (request.examples || []).map((example) => {
    if (String(example.openapiExampleSource?.status) !== String(oldStatus))
      return example;
    return {
      ...example,
      openapiExampleSource: move(example.openapiExampleSource),
      ...(String(example.status) === String(oldStatus)
        ? { status: Number(status) }
        : {}),
    };
  });
  return update;
}
