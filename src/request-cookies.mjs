export function normalizeCookieEncoding(value = "raw") {
  if (!["raw", "apipost", "apipost-name"].includes(value))
    throw Error("Cookie编码选项无效");
  return value;
}
// Preserve already escaped components under the explicitly selected compatibility policy.
function encodeOnce(value) {
  const text = String(value ?? "");
  if (text.startsWith("{{") && text.endsWith("}}")) return text;
  try {
    if (decodeURIComponent(text) !== text) return text;
  } catch {}
  return encodeURIComponent(text);
}
export function requestCookieHeader(rows, policy = "raw") {
  normalizeCookieEncoding(policy);
  const active = rows.filter((row) => row.enabled !== false && row.key);
  if (!active.length) return undefined;
  return active
    .map((row) => {
      const key = policy === "raw" ? String(row.key) : encodeOnce(row.key);
      const value =
        policy === "apipost" ? encodeOnce(row.value) : String(row.value);
      return key + "=" + value;
    })
    .join("; ");
}
