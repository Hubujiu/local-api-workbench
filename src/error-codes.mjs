export function validateErrorCodes(codes = []) {
  if (!Array.isArray(codes) || codes.length > 2000)
    throw Error("状态码/错误码字典最多2000项");
  const seen = new Set();
  for (const item of codes) {
    if (
      !item ||
      !["string", "number"].includes(typeof item.code) ||
      (typeof item.code === "number" && !Number.isSafeInteger(item.code))
    )
      throw Error("错误码必须是字符串或安全整数");
    const code = String(item.code);
    if (
      !code ||
      code.length > 128 ||
      /[\s:：\u0000-\u001f\u007f]/u.test(code) ||
      seen.has(code)
    )
      throw Error("状态码/错误码字典无效或重复");
    if (
      typeof item.label !== "string" ||
      !item.label.trim() ||
      item.label.length > 2000
    )
      throw Error("错误码说明须为1–2000字符");
    if (item.httpHint !== undefined && typeof item.httpHint !== "boolean")
      throw Error("HTTP提示开关必须为布尔值");
    if (item.httpHint === true && !/^[1-5]\d{2}$/.test(code))
      throw Error("HTTP状态提示仅支持100至599");
    seen.add(code);
  }
  return codes;
}
export function parseErrorCodeList(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 1024 * 1024)
    throw Error("错误码批量文本最多1 MiB");
  const result = source
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const separator = line.search(/[:：]/);
      if (separator < 1) throw Error("批量格式应为 错误码:描述");
      const rawCode = line.slice(0, separator).trim();
      const number = Number(rawCode);
      const code =
        Number.isSafeInteger(number) && String(number) === rawCode
          ? number
          : rawCode;
      const rawLabel = line.slice(separator + 1).trim();
      let label = rawLabel;
      if (rawLabel.startsWith('"')) {
        try {
          label = JSON.parse(rawLabel);
        } catch {
          throw Error("带引号的描述必须是有效JSON字符串");
        }
      }
      return { code, label };
    });
  return validateErrorCodes(result);
}
