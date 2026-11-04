import { types } from "node:util";
import { createHash } from "node:crypto";
import { prepareDefinitionExportScope } from "./definition-export-scope.mjs";
import { projectHistoryProjection } from "./request-definition-history.mjs";
import { exportApipost } from "./apipost-export.mjs";
import { exportApipostDirectory } from "./apipost-directory-export.mjs";
import {
  MCP_PROJECT_DOCUMENT_BYTES,
  MCP_PROJECT_FRAME_BYTES,
} from "./mcp-project-interchange.mjs";

export const SCOPED_EXPORT_ARGUMENT_BYTES = 2 * 1024 * 1024;
const formats = ["apipost", "apipost-directory"];
const safeErrors = new WeakMap();
const fail = (message) => {
  const error = Error("选择导出：" + message);
  safeErrors.set(error, error.message);
  throw error;
};
export function scopedExportErrorMessage(error) {
  return safeErrors.get(error) || "选择导出失败或当前授权已取消；未返回文档";
}
const plain = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

// This projection must precede *any* argument traversal in direct MCP calls.
// Reusing the descriptor-safe JSON mechanism does not apply history quotas.
export function scopedExportArguments(
  input,
  { exporting = false, mcp = false } = {},
) {
  let value;
  try {
    value = projectHistoryProjection(input, {
      maxBytes: SCOPED_EXPORT_ARGUMENT_BYTES,
      maxDepth: 16,
      maxNodes: 100000,
    });
  } catch {
    fail("参数必须为有界普通 JSON 数据，不能含代理、访问器或环");
  }
  if (!plain(value)) fail("参数必须为对象");
  const allowed = new Set([
    "format",
    "selection",
    "modelNameMode",
    "databaseMode",
    ...(mcp ? ["projectId"] : []),
    ...(exporting
      ? ["configRevision", "scopeDigest", "acceptedDependencies"]
      : []),
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail("未知参数");
  if (!formats.includes(value.format))
    fail("format 必须为 apipost 或 apipost-directory");
  if (!plain(value.selection)) fail("必须提供明确 selection");
  if (
    value.modelNameMode !== undefined &&
    !["namespaced", "preserve"].includes(value.modelNameMode)
  )
    fail("modelNameMode 无效");
  if (value.databaseMode !== undefined && value.databaseMode !== "rebind")
    fail("databaseMode 必须为 rebind");
  if (
    mcp &&
    (typeof value.projectId !== "string" ||
      !value.projectId ||
      Buffer.byteLength(value.projectId) > 200)
  )
    fail("projectId 无效");
  if (exporting) {
    if (!Number.isSafeInteger(value.configRevision) || value.configRevision < 0)
      fail("必须提供预览 configRevision");
    if (
      typeof value.scopeDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.scopeDigest)
    )
      fail("必须提供预览 scopeDigest");
    if (
      !Array.isArray(value.acceptedDependencies) ||
      value.acceptedDependencies.length > 10000
    )
      fail("必须明确接受预览依赖");
    const keys = value.acceptedDependencies.map((item) => {
      if (
        !plain(item) ||
        Object.keys(item).length !== 2 ||
        typeof item.kind !== "string" ||
        typeof item.id !== "string" ||
        !item.kind ||
        !item.id
      )
        fail("依赖身份无效");
      return JSON.stringify([item.kind, item.id]);
    });
    if (new Set(keys).size !== keys.length) fail("依赖身份重复");
  }
  return value;
}

function sourceMetadata(project) {
  if (
    !project ||
    typeof project !== "object" ||
    types.isProxy(project) ||
    Array.isArray(project) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(project))
  )
    fail("项目必须为普通 JSON 数据");
  const output = {};
  for (const key of ["id", "archived", "configRevision"]) {
    const descriptor = Object.getOwnPropertyDescriptor(project, key);
    if (
      descriptor &&
      (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
    )
      fail("项目元数据不能含访问器");
    output[key] = descriptor?.value;
  }
  if (
    typeof output.id !== "string" ||
    !output.id ||
    Buffer.byteLength(output.id) > 200
  )
    fail("项目身份无效");
  if (!Number.isSafeInteger(output.configRevision) || output.configRevision < 0)
    fail("项目配置版本无效");
  return output;
}
function build(project, args) {
  const metadata = sourceMetadata(project);
  if (metadata.archived) fail("项目已归档");
  let prepared;
  try {
    prepared = prepareDefinitionExportScope(project, args.selection);
  } catch {
    fail("selection 无效、必需依赖缺失或包含未证明可保真的引用；请调整选择");
  }
  const options = {
    modelNameMode: args.modelNameMode ?? "namespaced",
    databaseMode: args.databaseMode,
  };
  // A graph is not proof of exportability. Existing native converters perform
  // their own semantic and readback validation, without running user code.
  let document;
  try {
    document = (
      args.format === "apipost" ? exportApipost : exportApipostDirectory
    )(prepared.project, options);
  } catch {
    fail("所选资源或必需依赖无法保真转换为此原生格式；未生成文档");
  }
  const encoded = JSON.stringify(document);
  const documentBytes = Buffer.byteLength(encoded);
  if (documentBytes > MCP_PROJECT_DOCUMENT_BYTES)
    fail("原生文档超过 4 MiB 上限");
  // Directory conversion includes source timestamps. Bind the actual artifact,
  // not just configRevision or the selection graph, including activity changes.
  const digest = createHash("sha256")
    .update(
      JSON.stringify([prepared.scope.digest, args.format, options, document]),
    )
    .digest("hex");
  return {
    projectId: metadata.id,
    configRevision: metadata.configRevision,
    format: args.format,
    options: {
      modelNameMode: options.modelNameMode,
      databaseMode: options.databaseMode ?? null,
    },
    scope: { ...prepared.scope, digest },
    documentBytes,
    warnings: [
      "定义导出不是完整备份；执行记录、接口版本历史、回收站及计划未包含。",
      "所选定义及必需全局配置可能包含静态认证和变量；导出前应确认依赖，不要公开分享敏感文档。",
      ...(args.databaseMode === "rebind"
        ? ["数据库定义仅保留重绑定信息，运行时凭据和授权不会导出。"]
        : []),
    ],
    document,
  };
}

export function previewDefinitionExport(project, input, { mcp = false } = {}) {
  const args = scopedExportArguments(input);
  const output = build(project, args);
  // Preview promises deliverability, not merely a small metadata response.
  // The later request can use any permitted 256-byte ID; ASCII control bytes
  // have the worst JSON expansion (six encoded bytes per input byte).
  if (mcp) scopedExportMCPResult(output, "\0".repeat(256));
  const { document: _document, ...preview } = output;
  return preview;
}

export function exportDefinitionSelection(project, input) {
  const args = scopedExportArguments(input, { exporting: true });
  if (args.configRevision !== sourceMetadata(project).configRevision)
    fail("配置已变化，请重新预览");
  const output = build(project, args);
  if (args.scopeDigest !== output.scope.digest)
    fail("导出内容已变化，请重新预览");
  const key = (item) => JSON.stringify([item.kind, item.id]);
  const accepted = args.acceptedDependencies.map(key).sort();
  const required = output.scope.dependencies.map(key).sort();
  if (JSON.stringify(accepted) !== JSON.stringify(required))
    fail("必须准确接受预览列出的全部依赖，不可缺失或追加");
  return output;
}

export function scopedExportMCPResult(output, requestId) {
  const value = { content: [{ type: "text", text: JSON.stringify(output) }] };
  if (
    Buffer.byteLength(
      JSON.stringify({ jsonrpc: "2.0", id: requestId, result: value }) + "\n",
    ) > MCP_PROJECT_FRAME_BYTES
  )
    fail("完整 MCP 响应超过 8 MiB 上限");
  return value;
}
