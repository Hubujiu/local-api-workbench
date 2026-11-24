import { editSchemaNode, schemaRows } from "./schema-editor.js";

export function isModelRequiredProperty(row) {
  const node = row?.schema;
  return Boolean(
    row?.path.at(-2) === "properties" &&
      node &&
      typeof node === "object" &&
      !Array.isArray(node) &&
      !["$ref", "$dynamicRef", "$recursiveRef"].some((key) =>
        Object.hasOwn(node, key),
      ),
  );
}

export function setWorkspaceModelFieldRequired(schema, offset, required) {
  const row = Number.isSafeInteger(offset) && schemaRows(schema)[offset + 1];
  if (typeof required !== "boolean" || !isModelRequiredProperty(row))
    throw Error("当前字段不能在这里更改必需状态，请使用 Raw 编辑");
  if (row.required === required) return schema;
  const edited = editSchemaNode(schema, row.path, { required });
  if (!required) {
    const parent = row.path
      .slice(0, -2)
      .reduce((node, part) => node[part], edited);
    // Some supported Schema dialects do not allow an empty required array.
    if (!parent.required.length) delete parent.required;
  }
  return edited;
}
