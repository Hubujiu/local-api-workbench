import { referenceChildMode } from "./openapi-reference-context.mjs";

// Definition metadata, not an authenticity or tamper-proof assertion. Backups
// remain user-editable data. Never interpret this field in an external document.
export const schemaSourceKey = "x-local-api-nullable-source";
export function openAPIDialect(version) {
  return /^3\.0\./.test(version)
    ? "3.0"
    : /^3\.1\./.test(version)
      ? "3.1"
      : undefined;
}
export function retainNullableSources(document) {
  if (!document?.openapi) return document;
  const dialect = openAPIDialect(document.openapi);
  let nodes = 0;
  function visit(value, mode = "document", depth = 0) {
    if (mode === "literal") return structuredClone(value);
    if (++nodes > 50000 || depth > 60)
      throw Error("OpenAPI Schema 来源超过节点/深度上限");
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value))
      return value.map((child, index) =>
        visit(child, referenceChildMode(mode, String(index), child), depth + 1),
      );
    if (mode === "schema" && Object.hasOwn(value, schemaSourceKey))
      throw Error(
        "OpenAPI Schema 扩展名称与内部来源记录冲突: " + schemaSourceKey,
      );
    if (
      mode === "schema" &&
      dialect === "3.0" &&
      Object.hasOwn(value, "$ref") &&
      Object.hasOwn(value, "nullable")
    )
      throw Error(
        "OpenAPI 3.0 Reference Object 的 nullable 同级字段不支持无损导出",
      );
    const result = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        visit(child, referenceChildMode(mode, key, child), depth + 1),
      ]),
    );
    if (mode === "schema" && Object.hasOwn(value, "nullable") && dialect)
      result[schemaSourceKey] = {
        version: 1,
        dialect,
        nullable: structuredClone(value.nullable),
      };
    return result;
  }
  return visit(document);
}

// Updating a shared component must not reinterpret an identical nullable
// keyword under a different source dialect for its existing consumers.
export function assertCompatibleNullableSources(previous, next, mode) {
  let nodes = 0;
  function visit(a, b, context, depth = 0) {
    if (
      context === "literal" ||
      !a ||
      !b ||
      typeof a !== "object" ||
      typeof b !== "object"
    )
      return;
    if (++nodes > 50000 || depth > 60)
      throw Error("OpenAPI Schema 来源比较超过节点/深度上限");
    if (
      context === "schema" &&
      Object.hasOwn(a, "nullable") &&
      Object.hasOwn(b, "nullable") &&
      a[schemaSourceKey]?.dialect !== b[schemaSourceKey]?.dialect
    )
      throw Error("OpenAPI 组件 nullable 来源版本冲突；请使用独立组件名称");
    for (const key of Object.keys(b))
      if (Object.hasOwn(a, key))
        visit(
          a[key],
          b[key],
          referenceChildMode(context, key, b[key]),
          depth + 1,
        );
  }
  visit(previous, next, mode);
}
