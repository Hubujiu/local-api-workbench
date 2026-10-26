export function nativeXMLPath(expression) {
  if (typeof expression !== "string" || expression.length > 1000)
    throw Error("pickVars XML表达式最多1000字符");
  const value = expression.trim();
  const match =
    /^string\((\/[A-Za-z_][A-Za-z0-9_.-]*(?:\/[A-Za-z_][A-Za-z0-9_.-]*)*(?:\/@[A-Za-z_][A-Za-z0-9_.-]*)?)\)$/.exec(
      value,
    );
  if (!match || match[1].length > 1000 || match[1].split("/").length - 1 > 32)
    throw Error("pickVars XML仅支持string(绝对子路径)，最多32段/1000字符");
  return match[1];
}
