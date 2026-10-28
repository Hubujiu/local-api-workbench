import { validateQueryArrayRequest } from "./openapi-query-arrays.mjs";
import { normalizeScriptURLMode } from "../public/script-url-mode.js";
import { scriptStages } from "../public/shared-scripts.js";
import {
  initializeQueryRuntime,
  validateQueryRuntime,
  renderQueryRuntime,
} from "./script-url-runtime.mjs";

// Definition export never executes pre-request scripts or operations.
export function assertSDKCurlDefinition(request) {
  if (normalizeScriptURLMode(request.scriptURLMode) !== "sdk") return;
  if (scriptStages(request, "before").length || request.before?.length)
    throw Error(
      "SDK URL的cURL导出不执行前置脚本或操作，请先移除前置处理，或使用实际请求记录/项目备份",
    );
}

export function sdkCurlDefinition(request) {
  validateQueryArrayRequest(request);
  if (normalizeScriptURLMode(request.scriptURLMode) !== "sdk") return request;
  assertSDKCurlDefinition(request);
  const runtime = validateQueryRuntime(
    request.scriptURLRuntime === undefined
      ? initializeQueryRuntime(request)
      : request.scriptURLRuntime,
  );
  if (
    runtime.origins.some(
      (origin, index) =>
        origin.dynamic && !runtime.state.url.query[index].disabled,
    ) ||
    runtime.variableOrigins.some((origin) => origin.dynamic) ||
    ["headers", "cookies", "form"].some((group) =>
      (request[group] || []).some(
        (row) => row.enabled !== false && row.dynamic,
      ),
    ) ||
    /\{\{@value:[A-Za-z0-9_-]{1,100}\}\}/.test(String(request.body || ""))
  )
    throw Error("SDK URL动态值尚未解析，请使用带环境的cURL导出");
  const result = {
    ...request,
    url: renderQueryRuntime(runtime),
    query: [],
    path: [],
  };
  delete result.scriptURLMode;
  delete result.scriptURLRuntime;
  return result;
}
