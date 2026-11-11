import { types } from "node:util";
import { manualImportDigest } from "./manual-import-token.mjs";
const fail = () => {
  throw Error(
    "Postman独立环境仅支持明确标记、普通启用字符串变量；不支持的字段或语义不能丢弃",
  );
};
export function isPostmanEnvironmentDocument(document) {
  return (
    document !== null &&
    typeof document === "object" &&
    !types.isProxy(document) &&
    Object.hasOwn(document, "_postman_variable_scope")
  );
}
export function environmentTextRequired() {
  return Object.assign(
    Error("Postman独立环境导入必须提供原始JSON文本，不能使用已解析对象或YAML"),
    { code: "MANUAL_IMPORT_ENVIRONMENT_TEXT_REQUIRED" },
  );
}
export function requirePostmanEnvironmentText(document) {
  if (isPostmanEnvironmentDocument(document)) throw environmentTextRequired();
}
export function importPostmanEnvironment(document, id) {
  try {
    manualImportDigest(document, { maxBytes: 4 * 1024 * 1024 });
  } catch {
    fail();
  }
  if (
    !isPostmanEnvironmentDocument(document) ||
    document._postman_variable_scope !== "environment"
  )
    fail();
  const allowed = [
    "id",
    "name",
    "values",
    "_postman_variable_scope",
    "_postman_exported_at",
    "_postman_exported_using",
  ];
  if (Object.keys(document).some((key) => !allowed.includes(key))) fail();
  const text = (value, max, empty = false) =>
    typeof value === "string" &&
    (empty || value.trim().length > 0) &&
    value.length <= max &&
    value.isWellFormed() &&
    !value.includes("\0");
  if (
    !text(document.name, 200) ||
    !Array.isArray(document.values) ||
    document.values.length > 10000
  )
    fail();
  for (const key of ["id", "_postman_exported_at", "_postman_exported_using"])
    if (Object.hasOwn(document, key) && !text(document[key], 1000)) fail();
  const variables = {};
  for (const row of document.values) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).some(
        (key) => !["key", "value", "enabled", "type"].includes(key),
      ) ||
      !text(row.key, 200) ||
      ["__proto__", "prototype", "constructor"].includes(row.key) ||
      Object.hasOwn(variables, row.key) ||
      !text(row.value, 65536, true) ||
      /\{\{\s*vault\s*:/i.test(row.value) ||
      row.enabled !== true ||
      (Object.hasOwn(row, "type") && !["default", "text"].includes(row.type))
    )
      fail();
    variables[row.key] = row.value;
  }
  return { id: id(), name: document.name, variables, serverUrls: {} };
}
