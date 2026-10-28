import { isIP } from "node:net";

// Original bounded serialization of Postman's documented URL component format.
// Raw URLs keep their existing precedence; no URL parsing/encoding occurs here.
function rawImportURL(value, replaceQuery) {
  const hashAt = value.indexOf("#");
  const fragment = hashAt < 0 ? "" : value.slice(hashAt);
  const target = hashAt < 0 ? value : value.slice(0, hashAt);
  const queryAt = target.indexOf("?");
  const pathname = queryAt < 0 ? target : target.slice(0, queryAt);
  const query = queryAt < 0 || replaceQuery ? "" : target.slice(queryAt);
  return pathname.replace(/\/:([A-Za-z0-9_]+)/g, "/{$1}") + query + fragment;
}

export function postmanImportURL(url, replaceQuery = false) {
  if (typeof url === "string") return rawImportURL(url, replaceQuery);
  if (url === undefined || url === null) return "";
  const fail = () => {
    throw Error("Postman结构化URL字段不受支持或存在歧义");
  };
  if (typeof url !== "object" || Array.isArray(url)) fail();
  if (Object.hasOwn(url, "raw")) {
    if (typeof url.raw !== "string") fail();
    return rawImportURL(url.raw, replaceQuery);
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
    if (
      !literalHost.startsWith("[") ||
      !literalHost.endsWith("]") ||
      isIP(literalHost.slice(1, -1)) !== 6
    )
      fail();
  } else if (/[\[\]]/.test(literalHost)) fail();
  let pathname = "";
  if (Array.isArray(url.path)) {
    if (url.path.some((part) => /[\\/?#]/.test(withoutVariables(part)))) fail();
    pathname = url.path.length || host ? "/" + url.path.join("/") : "";
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
    pathname.replace(/\/:([A-Za-z0-9_]+)/g, "/{$1}") +
    (url.hash === undefined ? "" : "#" + url.hash);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail();
  return value;
}
