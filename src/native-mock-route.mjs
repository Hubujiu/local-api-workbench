// Independent, bounded segment router. No filesystem access or dynamic regex.
const plain = (x) => x && typeof x === "object" && !Array.isArray(x);
const safeId = (x) =>
  typeof x === "string" &&
  /^[A-Za-z0-9_-]{1,200}$/.test(x) &&
  !["__proto__", "prototype", "constructor"].includes(x);
function segments(path) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    Buffer.byteLength(path) > 8192 ||
    /[\0-\x1f\x7f\\?#]/.test(path)
  )
    throw Error("Mock路径无效或超过8KiB");
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw Error("Mock路径编码无效");
  }
  if (!decoded.isWellFormed() || /[\0-\x1f\x7f\\?#]/.test(decoded))
    throw Error("Mock路径包含不支持字符");
  const result = decoded.split("/").filter((x) => x.length);
  if (
    result.length > 100 ||
    result.some((x) => x === "." || x === ".." || x.length > 1000)
  )
    throw Error("Mock路径段无效或超限");
  return result;
}
export function normalizeNativeMockRoute(input) {
  if (
    !plain(input) ||
    Object.keys(input).some(
      (k) =>
        ![
          "version",
          "sourceTargetId",
          "sourceProjectId",
          "sourcePath",
        ].includes(k),
    ) ||
    input.version !== 1 ||
    !safeId(input.sourceTargetId) ||
    !safeId(input.sourceProjectId)
  )
    throw Error("原生Mock路由身份无效");
  segments(input.sourcePath);
  return {
    version: 1,
    sourceProjectId: input.sourceProjectId,
    sourceTargetId: input.sourceTargetId,
    sourcePath: input.sourcePath,
  };
}
export function nativeMockRouteFromSource(node, projectId) {
  // Older modern exports allowed opaque IDs; do not break their HTTP import.
  if (!safeId(projectId) || !safeId(String(node.target_id))) return undefined;
  if (typeof node.url !== "string" || !node.url.trim()) return undefined;
  let path = node.url.trim().split("?")[0];
  if (path.includes("://")) {
    try {
      const parsed = new URL(path);
      if (!["http:", "https:"].includes(parsed.protocol))
        throw Error("HTTP only");
      path = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  if (!path.startsWith("/")) path = "/" + path;
  try {
    return normalizeNativeMockRoute({
      version: 1,
      sourceProjectId: projectId,
      sourceTargetId: String(node.target_id),
      sourcePath: path,
    });
  } catch {
    return undefined;
  }
}
export function resolveNativeMockRoute(project, method, path, query) {
  const incoming = segments(path),
    candidates = (project.requests || []).filter(
      (r) => !r.deletedAt && r.nativeMockRoute,
    );
  if (candidates.length > 5000) throw Error("Mock路由候选超过5000项");
  const selectors = [];
  for (const key of ["apipost_id", "echoapi_id", "target_id"])
    for (const value of query.getAll(key)) {
      if (value) {
        if (!safeId(value)) throw Error("Mock接口选择标识无效");
        selectors.push(value);
      }
    }
  if (new Set(selectors).size > 1) throw Error("Mock接口选择标识冲突");
  const selected = selectors[0];
  const matches = candidates.filter((request) => {
    const route = normalizeNativeMockRoute(request.nativeMockRoute);
    if (selected) return route.sourceTargetId === selected;
    if (request.method !== method) return false;
    // Imported provenance stays frozen, but routing follows the current saved URL.
    if (typeof request.url !== "string" || !request.url.trim()) return false;
    const current = nativeMockRouteFromSource(
      { url: request.url, target_id: route.sourceTargetId },
      route.sourceProjectId,
    );
    if (!current) return false;
    const expected = segments(current.sourcePath);
    if (expected.length !== incoming.length) return false;
    return expected.every((value, i) => {
      const wildcard =
        value.length > 2 && value[0] === "{" && value.at(-1) === "}";
      return wildcard || value === incoming[i];
    });
  });
  if (matches.length > 1) {
    const error = Error("Mock路径匹配多个接口，请指定唯一接口标识");
    error.statusCode = 409;
    throw error;
  }
  return matches[0];
}
