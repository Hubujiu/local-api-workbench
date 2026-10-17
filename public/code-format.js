export function escapeCode(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}
export function highlightJSON(source) {
  const expression =
    /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b/g;
  let html = "",
    offset = 0;
  for (const match of String(source).matchAll(expression)) {
    html += escapeCode(source.slice(offset, match.index));
    const token = match[0];
    const type = token.startsWith('"')
      ? /^\s*:/.test(source.slice(match.index + token.length))
        ? "key"
        : "string"
      : /^-?\d/.test(token)
        ? "number"
        : "literal";
    html += `<span class="syntax-${type}">${escapeCode(token)}</span>`;
    offset = match.index + token.length;
  }
  return html + escapeCode(source.slice(offset));
}
