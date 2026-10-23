// The search string is the entire field, so replacement prefix/suffix are empty.
// Build pieces only while the serialized UTF-8 result stays within the existing cap.
export function replaceExactApipostTemplate(expression, replacement) {
  const limit = 65536;
  if (
    typeof expression !== "string" ||
    typeof replacement !== "string" ||
    Buffer.byteLength(expression, "utf8") > limit ||
    Buffer.byteLength(replacement, "utf8") > limit
  )
    throw Error("原版模板替换输入超过64KiB或类型无效");
  const parts = [];
  let bytes = 2,
    cursor = 0;
  const append = (piece) => {
    bytes += Buffer.byteLength(JSON.stringify(piece), "utf8") - 2;
    if (bytes > limit) throw Error("原版模板替换结果超过64KiB");
    if (piece) parts.push(piece);
  };
  for (const match of replacement.matchAll(/\$(\$|&|`|')/g)) {
    append(replacement.slice(cursor, match.index));
    append(match[1] === "$" ? "$" : match[1] === "&" ? expression : "");
    cursor = match.index + match[0].length;
  }
  append(replacement.slice(cursor));
  return parts.join("");
}
