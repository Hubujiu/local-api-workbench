// Original bounded serialization of Postman's documented URL component format.
// Raw URLs keep their existing precedence; no URL parsing/encoding occurs here.
export function postmanImportURL(url) {
  if (typeof url === "string") return url;
  if (url === undefined || url === null) return "";
  const fail = () => {
    throw Error("Postman结构化URL字段不受支持或存在歧义");
  };
  if (typeof url !== "object" || Array.isArray(url)) fail();
  if (Object.hasOwn(url, "raw")) {
    if (typeof url.raw !== "string") fail();
    return url.raw;
  }
  for (const key of ["protocol", "port", "hash"])
    if (url[key] !== undefined && typeof url[key] !== "string") fail();
  const strings = (value) =>
    typeof value === "string" ||
    (Array.isArray(value) && value.every((part) => typeof part === "string"));
  for (const key of ["host", "path"])
    if (url[key] !== undefined && !strings(url[key])) fail();
  // Embedded credentials must never silently disappear into an unauthenticated request.
  if (
    url.auth !== undefined ||
    url.username !== undefined ||
    url.password !== undefined
  )
    fail();
  const host = Array.isArray(url.host) ? url.host.join(".") : url.host || "";
  const protocol = url.protocol || "";
  const port = url.port || "";
  const withoutVariables = (value) =>
    value.replace(/\{\{[^{}]+\}\}/g, "placeholder");
  if (/[\s\\/?#@]/.test(withoutVariables(host))) fail();
  if (protocol && !["http", "https"].includes(protocol)) fail();
  if (port && !/^(?:\d{1,5}|\{\{[^{}]+\}\})$/.test(port)) fail();
  if (/^\d+$/.test(port) && (+port < 1 || +port > 65535)) fail();
  const literalHost = withoutVariables(host);
  if (literalHost.includes(":")) {
    // Bracketed IPv6 only; colons may not smuggle a port or credentials.
    if (!/^\[[0-9a-fA-F:.]+\]$/.test(literalHost)) fail();
  } else if (/[\[\]]/.test(literalHost)) fail();
  let pathname = "";
  if (Array.isArray(url.path)) {
    if (url.path.some((part) => /[\\/?#]/.test(withoutVariables(part)))) fail();
    pathname = "/" + url.path.join("/");
  } else if (url.path) {
    if (/[\\?#]/.test(withoutVariables(url.path))) fail();
    pathname = url.path.startsWith("/") ? url.path : "/" + url.path;
  }
  if (!host) {
    if (protocol || port || pathname || url.hash !== undefined) fail();
    return ""; // Existing empty URL draft, including query/path-variable rows.
  }
  // A base-URL variable can include its scheme; do not invent http:// for host-only input.
  if (!protocol && !/^\{\{[^{}]+\}\}$/.test(host)) fail();
  const value =
    (protocol ? protocol + "://" : "") +
    host +
    (port ? ":" + port : "") +
    pathname +
    (url.hash === undefined ? "" : "#" + url.hash);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail();
  return value;
}
