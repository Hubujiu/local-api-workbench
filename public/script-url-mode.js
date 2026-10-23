export function normalizeScriptURLMode(value = "string") {
  if (value !== "string" && value !== "sdk")
    throw Error("URL脚本模式必须为 string 或 sdk");
  return value;
}
export const scriptURLModeNotice =
  "SDK URL模式将本请求及共享脚本中的 pm.request.url / apt.request.url 改为可变Url对象，而非字符串。原URL查询保留原编码，Query表格项仍按表单编码；Path整段 {name} 转为SDK路径变量。状态最多64KiB，不支持函数值或外部变量解析器；cURL/OpenAPI暂不支持此模式，请使用项目备份。";
export function scriptURLModeOptions(value) {
  const mode = normalizeScriptURLMode(value);
  return `<option value="string" ${mode === "string" ? "selected" : ""}>原有 URL 字符串</option><option value="sdk" ${mode === "sdk" ? "selected" : ""}>SDK URL 对象（有界子集）</option>`;
}
