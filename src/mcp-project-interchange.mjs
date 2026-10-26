import { importIntoProject } from "./core.mjs";
import { apipostDocument } from "./apipost-import.mjs";
import { isApipostDirectoryDocument } from "./apipost-directory.mjs";
import { exportApipost } from "./apipost-export.mjs";
import { exportApipostDirectory } from "./apipost-directory-export.mjs";

export const MCP_PROJECT_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const MCP_PROJECT_FRAME_BYTES = 8 * 1024 * 1024;
const maxDepth = 64;
const maxValues = 200000;
const formats = ["apipost", "apipost-directory"];

function format(value) {
  if (!formats.includes(value))
    throw Error("format 必须明确为 apipost 或 apipost-directory");
}

// Transport JSON has no accessors, cycles or custom prototypes. Also enforce
// that contract on direct dispatch before cloning or invoking an exporter.
function boundedDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw Error("document 必须是 JSON 对象；不读取路径或 URL");
  let values = 0,
    lowerBoundBytes = 0;
  const ancestors = new Set();
  function visit(value, depth) {
    if (++values > maxValues || depth > maxDepth)
      throw Error("项目文档最多200000个值、64层");
    if (typeof value === "string") lowerBoundBytes += Buffer.byteLength(value);
    else if (value !== null && typeof value === "object") {
      const array = Array.isArray(value);
      if (
        (array
          ? Object.getPrototypeOf(value) !== Array.prototype
          : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) ||
        ancestors.has(value)
      )
        throw Error("项目文档必须为无环普通 JSON");
      ancestors.add(value);
      const keys = Reflect.ownKeys(value);
      if (keys.length > maxValues) throw Error("项目文档字段过多");
      for (const key of keys) {
        if (array && key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          typeof key !== "string" ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value") ||
          (array && !/^(0|[1-9][0-9]*)$/.test(key))
        )
          throw Error("项目文档必须为普通 JSON 数据字段");
        if (!array) lowerBoundBytes += Buffer.byteLength(key);
        visit(descriptor.value, depth + 1);
      }
      if (array && keys.length !== value.length + 1)
        throw Error("项目文档不能包含稀疏数组");
      ancestors.delete(value);
    } else if (
      value !== null &&
      typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))
    )
      throw Error("项目文档必须为 JSON 数据");
    if (lowerBoundBytes > MCP_PROJECT_DOCUMENT_BYTES)
      throw Error("MCP 项目文档序列化 UTF-8 最多4MiB");
  }
  visit(document, 0);
  if (Buffer.byteLength(JSON.stringify(document)) > MCP_PROJECT_DOCUMENT_BYTES)
    throw Error("MCP 项目文档序列化 UTF-8 最多4MiB");
}

// Directory entries are JSON text, not host files. Bound nesting before the
// existing directory assembler parses them; it remains the sole format parser.
function boundedDirectoryText(text) {
  let depth = 0,
    tokens = 0,
    quoted = false,
    escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      if (++depth > maxDepth) throw Error("目录 JSON 最多64层");
      if (++tokens > maxValues) throw Error("目录 JSON 结构过大");
    } else if (character === "}" || character === "]") depth--;
    else if (character === "," && ++tokens > maxValues)
      throw Error("目录 JSON 结构过大");
  }
}

function toolResult(output, requestId) {
  const result = { content: [{ type: "text", text: JSON.stringify(output) }] };
  // Count the real doubly-escaped JSON-RPC envelope, including its stdio newline.
  // Never leave rejection to a transport writer after a successful mutation.
  const frame = JSON.stringify({ jsonrpc: "2.0", id: requestId, result });
  if (Buffer.byteLength(frame) + 1 > MCP_PROJECT_FRAME_BYTES)
    throw Error("MCP 项目结果完整帧 UTF-8 最多8MiB；请缩小项目文档");
  return result;
}

export function exportMCPProject(project, args, requestId) {
  format(args.format);
  const document =
    args.format === "apipost"
      ? exportApipost(project)
      : exportApipostDirectory(project);
  boundedDocument(document);
  return toolResult(
    { projectId: project.id, format: args.format, document },
    requestId,
  );
}

export async function importMCPProject(store, project, args, requestId) {
  format(args.format);
  boundedDocument(args.document);
  const directory = isApipostDirectoryDocument(args.document);
  if (
    args.format === "apipost-directory"
      ? !directory
      : directory || !apipostDocument(args.document)
  )
    throw Error("document 与显式 format 不匹配；不自动识别其他格式");
  if (directory && Array.isArray(args.document.files))
    for (const entry of args.document.files)
      if (typeof entry?.text === "string") boundedDirectoryText(entry.text);
  const draft = structuredClone(project);
  importIntoProject(draft, structuredClone(args.document), { sync: false });
  const imported = {};
  for (const [collection, key] of [
    ["requests", "requestIds"],
    ["plans", "planIds"],
    ["environments", "environmentIds"],
    ["cases", "caseIds"],
    ["protocols", "protocolIds"],
    ["documents", "documentIds"],
  ]) {
    const previous = new Set(
      (project[collection] || []).map((item) => item.id),
    );
    imported[key] = (draft[collection] || [])
      .filter((item) => !previous.has(item.id))
      .map((item) => item.id);
  }
  const result = toolResult(
    { projectId: project.id, format: args.format, imported },
    requestId,
  );
  // Store owns validation, optimistic concurrency and durable commit outcomes.
  // Do not retry or translate an uncertain commit into a claim of rollback.
  await store.save(draft);
  return result;
}
