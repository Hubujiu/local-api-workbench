import { validatePathSerialization } from "./path-serialization.mjs";
import { normalizeScriptURLMode } from "../public/script-url-mode.js";
import { scriptStages } from "../public/shared-scripts.js";
import { applySharedScripts } from "./shared-scripts.mjs";
import { sdkCurlDefinition } from "./script-url-export.mjs";
import { openAPIURLQuery } from "./openapi-url-query.mjs";

// Project only a static definition, never evaluate scripts or dynamic providers.
export function sdkOpenAPIDefinition(project, request) {
  validatePathSerialization(request);
  if (normalizeScriptURLMode(request.scriptURLMode) !== "sdk") return request;
  if (
    scriptStages(applySharedScripts(project, request), "before").length ||
    request.before?.length
  )
    throw Error("SDK URL的OpenAPI导出不执行前置脚本或操作，请使用项目备份");
  if (!/^(?:https?:\/\/|\/(?!\/))/i.test(request.url))
    throw Error("OpenAPI静态SDK相对URL须以单个斜杠开头，请使用项目备份");
  const parsedURL = new URL(request.url, "http://definition.invalid");
  if (
    parsedURL.username ||
    parsedURL.password ||
    !["http:", "https:"].includes(parsedURL.protocol)
  )
    throw Error("OpenAPI静态SDK URL不支持内联凭据或非HTTP协议");
  if (
    request.scriptURLRuntime !== undefined ||
    /%7[bd]/i.test(request.url) ||
    /[{}]/.test(parsedURL.search)
  )
    throw Error(
      "OpenAPI暂不支持SDK URL运行时状态或未解析URL模板，请使用项目备份",
    );
  const names = [];
  for (const segment of parsedURL.pathname.split("/")) {
    const match =
      /^(?:%7B([A-Za-z0-9_-]{1,100})%7D|:([A-Za-z0-9_-]{1,100}))$/i.exec(
        segment,
      );
    if (match) names.push(match[1] || match[2]);
    else if (/%7[bd]/i.test(segment) || segment.startsWith(":"))
      throw Error("OpenAPI静态SDK Path只支持完整的命名路径段");
  }
  if (new Set(names).size !== names.length)
    throw Error("OpenAPI静态SDK Path暂不支持重复路径占位符");
  const path = (request.path || []).filter(
    (row) => row.enabled !== false && row.key,
  );
  if (
    path.length !== names.length ||
    new Set(path.map((row) => row.key)).size !== path.length ||
    path.some(
      (row) =>
        !names.includes(row.key) ||
        row.dynamic ||
        typeof row.value !== "string" ||
        !/^[A-Za-z0-9._~-]+$/.test(row.value),
    )
  )
    throw Error(
      "OpenAPI静态SDK Path须与占位符一一对应且示例为非空未保留字符文本，不支持动态路径",
    );
  // Keep named segments in the exported definition instead of rendering examples.
  const rendered = sdkCurlDefinition({ ...request, path: [] }),
    projection = openAPIURLQuery(rendered);
  const pathURL = projection.pathURL
    .split("/")
    .map((segment) =>
      segment.startsWith(":") && names.includes(segment.slice(1))
        ? "{" + segment.slice(1) + "}"
        : segment,
    )
    .join("/");
  const metadata = new Map(
    (request.query || [])
      .filter((row) => row.enabled !== false && row.key)
      .map((row) => [String(row.key), row]),
  );
  return {
    ...rendered,
    url: pathURL,
    query: projection.query.map((row) => ({
      ...row,
      ...structuredClone(metadata.get(row.key) || {}),
      key: row.key,
      value: row.value,
      enabled: true,
    })),
    path: structuredClone(path),
  };
}
