import { normalizeScriptURLMode } from "../public/script-url-mode.js";
import { scriptStages } from "../public/shared-scripts.js";
import { applySharedScripts } from "./shared-scripts.mjs";
import { sdkCurlDefinition } from "./script-url-export.mjs";
import { openAPIURLQuery } from "./openapi-url-query.mjs";

// Project only a static definition, never evaluate scripts or dynamic providers.
export function sdkOpenAPIDefinition(project, request) {
  if (normalizeScriptURLMode(request.scriptURLMode) !== "sdk") return request;
  if (
    scriptStages(applySharedScripts(project, request), "before").length ||
    request.before?.length
  )
    throw Error("SDK URL的OpenAPI导出不执行前置脚本或操作，请使用项目备份");
  const parsedURL = new URL(request.url, "http://definition.invalid");
  if (
    parsedURL.username ||
    parsedURL.password ||
    !["http:", "https:"].includes(parsedURL.protocol)
  )
    throw Error("OpenAPI静态SDK URL不支持内联凭据或非HTTP协议");
  if (
    request.scriptURLRuntime !== undefined ||
    (request.path || []).some((row) => row.enabled !== false && row.key) ||
    /[{}]/.test(request.url) ||
    /%7[bd]/i.test(parsedURL.pathname) ||
    /(?:^|\/)\:[^/]+/.test(parsedURL.pathname)
  )
    throw Error(
      "OpenAPI暂不支持SDK URL运行时状态、Path变量或未解析URL模板，请使用项目备份",
    );
  const rendered = sdkCurlDefinition(request),
    projection = openAPIURLQuery(rendered);
  const metadata = new Map(
    (request.query || [])
      .filter((row) => row.enabled !== false && row.key)
      .map((row) => [String(row.key), row]),
  );
  return {
    ...rendered,
    url: projection.pathURL,
    query: projection.query.map((row) => ({
      ...row,
      ...structuredClone(metadata.get(row.key) || {}),
      key: row.key,
      value: row.value,
      enabled: true,
    })),
    path: [],
  };
}
