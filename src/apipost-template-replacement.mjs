// Match native string-search replacement tokens without re-evaluating inserted text.
// Build pieces only while the serialized UTF-8 result stays within the existing cap.
export function replaceApipostFieldTemplate(field, expression, replacement) {
  const limit = 65536;
  if (
    typeof field !== "string" ||
    Buffer.byteLength(field, "utf8") > limit ||
    typeof expression !== "string" ||
    typeof replacement !== "string" ||
    Buffer.byteLength(expression, "utf8") > limit ||
    Buffer.byteLength(replacement, "utf8") > limit
  )
    throw Error("原版模板替换输入超过64KiB或类型无效");
  const at = field.indexOf(expression);
  if (at < 0) throw Error("原版模板替换目标不存在");
  const prefix = field.slice(0, at),
    suffix = field.slice(at + expression.length);
  const parts = [];
  let bytes = 2,
    cursor = 0;
  const append = (piece) => {
    bytes += Buffer.byteLength(JSON.stringify(piece), "utf8") - 2;
    if (bytes > limit) throw Error("原版模板替换结果超过64KiB");
    if (piece) parts.push(piece);
  };
  append(prefix);
  for (const match of replacement.matchAll(/\$(\$|&|`|')/g)) {
    append(replacement.slice(cursor, match.index));
    append(
      match[1] === "$"
        ? "$"
        : match[1] === "&"
          ? expression
          : match[1] === "`"
            ? prefix
            : suffix,
    );
    cursor = match.index + match[0].length;
  }
  append(replacement.slice(cursor));
  append(suffix);
  return parts.join("");
}

export function replaceExactApipostTemplate(expression, replacement) {
  return replaceApipostFieldTemplate(expression, expression, replacement);
}
