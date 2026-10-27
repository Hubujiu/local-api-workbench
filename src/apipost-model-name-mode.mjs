// Caller-controlled interchange option; never read from imported document fields.
export function modelNameMode(value) {
  if (value === undefined) return "namespaced";
  if (value !== "namespaced" && value !== "preserve")
    throw Error("modelNameMode必须为namespaced或preserve");
  return value;
}
export function validatePreservedModelName(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    !value.isWellFormed()
  )
    throw Error("原样模型名称必须为有效Unicode非空字符串且最多200字符");
  return value;
}
