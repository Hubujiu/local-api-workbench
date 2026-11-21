const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
export function schemaRows(schema, path = [], name = "根节点", depth = 0) {
  if (depth > 16) return [];
  const rows = [{ name, path, depth, schema }];
  if (schema && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema.properties || {}))
      rows.push(
        ...schemaRows(value, [...path, "properties", key], key, depth + 1),
      );
    if (schema.items && !Array.isArray(schema.items))
      rows.push(
        ...schemaRows(schema.items, [...path, "items"], "items", depth + 1),
      );
  }
  return rows;
}
export function changeSchemaDescription(schema, path, description) {
  const copy = structuredClone(schema);
  let node = copy;
  for (const key of path) {
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key))
      throw new Error("结构已变化，请重新编辑");
    node = node[key];
  }
  if (!node || typeof node !== "object" || Array.isArray(node))
    throw new Error("布尔 Schema 不支持描述字段");
  if (description) node.description = description;
  else delete node.description;
  return copy;
}
export function designSchemaHTML(schema) {
  return `<div class="design-schema-tree" role="table" aria-label="请求数据结构"><div role="row" class="design-schema-columns"><span role="columnheader">字段</span><span role="columnheader">类型</span><span role="columnheader">描述</span></div>${schemaRows(
    schema,
  )
    .map(({ name, path, depth, schema: node }) => {
      const type =
        node === true
          ? "any"
          : node === false
            ? "never"
            : node?.$ref
              ? "$ref"
              : Array.isArray(node?.type)
                ? node.type.join(" | ")
                : node?.type || "—";
      const editable = node && typeof node === "object" && !Array.isArray(node);
      return `<div role="row" class="design-schema-row"><span role="cell" class="design-schema-depth-${depth}">${escape(name)}</span><span role="cell"><span class="design-schema-type" data-schema-type="${escape(type)}">${escape(type)}</span></span><span role="cell">${editable ? `<input data-schema-description="${escape(JSON.stringify(path))}" aria-label="${escape(name)}描述" placeholder="描述" value="${escape(node.description)}">` : '<span class="muted">布尔 Schema</span>'}</span></div>`;
    })
    .join("")}</div>`;
}
export function bindDesignSchema(container) {
  if (!container) return;
  const source = container.querySelector("#schema");
  const tree = container.querySelector("#design-schema-tree");
  const refresh = () => {
    try {
      tree.innerHTML = designSchemaHTML(JSON.parse(source.value));
    } catch {
      tree.textContent = "JSON Schema 格式无效，请在源编辑中修正。";
    }
  };
  source.addEventListener("input", refresh);
  tree.addEventListener("input", (event) => {
    const input = event.target.closest("[data-schema-description]");
    if (!input) return;
    try {
      source.value = JSON.stringify(
        changeSchemaDescription(
          JSON.parse(source.value),
          JSON.parse(input.dataset.schemaDescription),
          input.value,
        ),
        null,
        2,
      );
      source.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {
      refresh();
    }
  });
  refresh();
}
