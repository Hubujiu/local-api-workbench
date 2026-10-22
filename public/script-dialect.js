/** Explicit compatibility choice: existing projects never change semantics silently. */
export function normalizeScriptDialect(value = "legacy") {
  if (value !== "legacy" && value !== "apipost8")
    throw Error("脚本兼容模式必须为 legacy 或 apipost8");
  return value;
}
export function scriptDialectOptions(value) {
  const selected = normalizeScriptDialect(value);
  return `<option value="legacy" ${selected === "legacy" ? "selected" : ""}>原有兼容模式（JSON属性 / 环境变量）</option><option value="apipost8" ${selected === "apipost8" ? "selected" : ""}>Apipost 8 子集（JSON方法 / 请求变量）</option>`;
}
export const scriptDialectNotice =
  "切换会改变本请求及其共享脚本中的 apt.response.json、headers、cookies 和 apt.variables 语义；Apipost 8 子集使用 json()、集合读取方法和请求局部变量。pm API 不变，不代表完整 SDK 兼容。";
