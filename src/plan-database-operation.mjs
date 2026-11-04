// Pure validation shared by legacy execution and opt-in graph preflight.
// Keep header/binding separate: legacy execution checks its budget and query
// capability between them, and those error-ordering semantics are intentional.
export function validateDatabaseOperationHeader(operation) {
  if (operation.enabled !== undefined && typeof operation.enabled !== "boolean")
    throw Error("数据库操作启用标识必须为布尔值");
  if (operation.enabled === false) return false;
  if (
    operation.path !== undefined &&
    (typeof operation.path !== "string" || operation.path.length > 1000)
  )
    throw Error("数据库提取路径无效");
  if ((operation.parameters || []).length > 1000)
    throw Error("数据库绑定参数最多1000项");
  return true;
}

export function validateDatabaseOperationBinding(operation) {
  if (
    !operation.name ||
    typeof operation.name !== "string" ||
    operation.name.length > 100 ||
    ["__proto__", "constructor", "prototype"].includes(operation.name)
  )
    throw Error("数据库结果变量名无效");
  if (
    typeof operation.connectionId !== "string" ||
    typeof operation.sql !== "string" ||
    operation.sql.length > 50000 ||
    !Array.isArray(operation.parameters ?? [])
  )
    throw Error("数据库操作配置无效");
}
