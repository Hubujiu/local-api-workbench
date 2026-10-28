import { types } from "node:util";

export const importedExecutionChunkDefaultBytes = 64 * 1024;
export const importedExecutionChunkMaxBytes = 256 * 1024;
export const importedExecutionChunkError =
  "原始执行记录分块读取失败：请检查参数、项目授权及来源记录是否仍匹配";

function plain(value) {
  // Check proxies before reflection: even getPrototypeOf/ownKeys can run code.
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error(importedExecutionChunkError);
}

function fields(value, allowed) {
  plain(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length) throw Error(importedExecutionChunkError);
  const result = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key))
      throw Error(importedExecutionChunkError);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      throw Error(importedExecutionChunkError);
    result[key] = descriptor.value;
  }
  return result;
}

export function validateImportedExecutionChunk(value) {
  const input = fields(value, [
    "offsetBytes",
    "maxBytes",
    "expectedArtifactSha256",
  ]);
  const offsetBytes = input.offsetBytes;
  const maxBytes = Object.hasOwn(input, "maxBytes")
    ? input.maxBytes
    : importedExecutionChunkDefaultBytes;
  if (
    !Number.isSafeInteger(offsetBytes) ||
    offsetBytes < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > importedExecutionChunkMaxBytes
  )
    throw Error(importedExecutionChunkError);
  const hasDigest = Object.hasOwn(input, "expectedArtifactSha256");
  if (
    (offsetBytes > 0 && !hasDigest) ||
    (hasDigest &&
      (typeof input.expectedArtifactSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.expectedArtifactSha256)))
  )
    throw Error(importedExecutionChunkError);
  return {
    offsetBytes,
    maxBytes,
    ...(hasDigest
      ? { expectedArtifactSha256: input.expectedArtifactSha256 }
      : {}),
  };
}

export function validateImportedExecutionChunkProjectId(projectId) {
  if (
    typeof projectId !== "string" ||
    !projectId.length ||
    Buffer.byteLength(projectId, "utf8") > 1024
  )
    throw Error(importedExecutionChunkError);
}

// Called before MCP's generic Object.entries validator. Omitted chunk preserves
// the existing full-response path; present chunk has a closed data-only envelope.
export function importedExecutionChunkArguments(args) {
  if (types.isProxy(args)) throw Error(importedExecutionChunkError);
  if (!args || typeof args !== "object") return null;
  if (!Object.getOwnPropertyDescriptor(args, "chunk")) return null;
  const input = fields(args, [
    "projectId",
    "sourceProjectId",
    "runId",
    "chunk",
  ]);
  validateImportedExecutionChunkProjectId(input.projectId);
  return {
    projectId: input.projectId,
    sourceProjectId: input.sourceProjectId,
    runId: input.runId,
    chunk: validateImportedExecutionChunk(input.chunk),
  };
}
