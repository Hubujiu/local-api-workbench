import { createHash } from "node:crypto";
import { types } from "node:util";

export const EXECUTION_RESULT_MAX_BYTES = 32 * 1024 * 1024;
export const EXECUTION_RESULT_MAX_VALUES = 200000;
export const EXECUTION_RESULT_MAX_DEPTH = 64;
export const EXECUTION_RESULT_CHUNK_DEFAULT_BYTES = 64 * 1024;
export const EXECUTION_RESULT_CHUNK_MAX_BYTES = 256 * 1024;
const limitError = () =>
  Error("执行记录超过分块读取上限，请由项目所有者使用本地项目备份导出");
const jsonError = () => Error("执行记录不是受支持的纯 JSON 数据");
const argumentError = () => Error("执行结果分块参数无效");

// Unknown storage/parse failures must not expose filesystem paths or record
// fragments. Existing tools keep their existing error contracts.
export function executionResultChunkError(error) {
  const message = error?.message;
  return [
    "执行结果分块参数无效",
    "项目未授权",
    "项目已归档",
    "记录 ID 不唯一",
    "记录不存在",
    "执行记录摘要不匹配或已变更",
    "执行结果分块偏移超出范围",
    limitError().message,
    jsonError().message,
  ].includes(message)
    ? message
    : "执行结果分块读取失败";
}

// A direct JavaScript caller must not cause getters/proxy traps to run, even
// before normal MCP validation. JSON transport callers naturally meet this.
export function executionResultChunkArguments(input) {
  if (!input || typeof input !== "object" || types.isProxy(input))
    throw argumentError();
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) throw argumentError();
  const keys = Reflect.ownKeys(input);
  const permitted = [
    "projectId",
    "runId",
    "offsetBytes",
    "maxBytes",
    "expectedSha256",
  ];
  if (keys.length > permitted.length) throw argumentError();
  const args = Object.create(null);
  for (const key of keys) {
    if (!permitted.includes(key)) throw argumentError();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      throw argumentError();
    args[key] = descriptor.value;
  }
  for (const key of ["projectId", "runId"])
    if (
      typeof args[key] !== "string" ||
      !args[key].length ||
      args[key].length > 4096 ||
      Buffer.byteLength(args[key], "utf8") > 4096
    )
      throw argumentError();
  if (!Number.isSafeInteger(args.offsetBytes) || args.offsetBytes < 0)
    throw argumentError();
  if (!Object.hasOwn(args, "maxBytes"))
    args.maxBytes = EXECUTION_RESULT_CHUNK_DEFAULT_BYTES;
  if (
    !Number.isInteger(args.maxBytes) ||
    args.maxBytes < 1 ||
    args.maxBytes > EXECUTION_RESULT_CHUNK_MAX_BYTES
  )
    throw argumentError();
  if (
    (args.offsetBytes > 0 && args.expectedSha256 === undefined) ||
    (Object.hasOwn(args, "expectedSha256") &&
      (typeof args.expectedSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(args.expectedSha256)))
  )
    throw argumentError();
  return args;
}

// Store already loads the whole project/history. This is a bounded additional
// serialization, NOT streaming storage or a whole-process memory guarantee.
// Account for JSON escaping and UTF-8 exactly before allocating the JSON text.
function snapshotWithinBudget(record) {
  let bytes = 0;
  let values = 0;
  const active = new WeakSet();
  const add = (count) => {
    bytes += count;
    if (bytes > EXECUTION_RESULT_MAX_BYTES) throw limitError();
  };
  const string = (value) => {
    // Even ASCII requires at least one byte per UTF-16 code unit plus quotes.
    if (value.length + 2 > EXECUTION_RESULT_MAX_BYTES - bytes)
      throw limitError();
    add(2);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code === 34 || code === 92) add(2);
      else if (code < 32) add([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(4);
          i++;
        } else add(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) add(6);
      else add(3);
    }
  };
  const visit = (value, depth) => {
    if (
      ++values > EXECUTION_RESULT_MAX_VALUES ||
      depth > EXECUTION_RESULT_MAX_DEPTH
    )
      throw limitError();
    if (value === null) {
      add(4);
      return null;
    }
    if (typeof value === "string") {
      string(value);
      return value;
    }
    if (typeof value === "boolean") {
      add(value ? 4 : 5);
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      add(JSON.stringify(value).length);
      return value;
    }
    if (typeof value !== "object" || types.isProxy(value)) throw jsonError();
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (
      proto !== null &&
      proto !== (array ? Array.prototype : Object.prototype)
    )
      throw jsonError();
    if (active.has(value)) throw jsonError();
    active.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length - (array ? 1 : 0) > EXECUTION_RESULT_MAX_VALUES - values)
      throw limitError();
    const copy = array ? [] : Object.create(null);
    if (array) Object.setPrototypeOf(copy, null);
    add(2);
    let count = 0;
    const length = array
      ? Object.getOwnPropertyDescriptor(value, "length").value
      : 0;
    if (
      array &&
      (length > EXECUTION_RESULT_MAX_VALUES - values ||
        keys.length !== length + 1)
    )
      throw limitError();
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") throw jsonError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        throw jsonError();
      if (count) add(1);
      if (array) {
        if (key !== String(count)) throw jsonError();
      } else {
        string(key);
        add(1);
      }
      copy[key] = visit(descriptor.value, depth + 1);
      count++;
    }
    active.delete(value);
    return copy;
  };
  return { snapshot: visit(record, 0), bytes };
}

export function executionResultChunk(record, input) {
  const args = executionResultChunkArguments(input);
  const { snapshot, bytes } = snapshotWithinBudget(record);
  // The inert snapshot has no accessors, functions, proxies, or inherited
  // toJSON hook. For persisted JSON it has exactly JSON.stringify(record)'s
  // order and values, including JSON's escaping of unpaired surrogates.
  const data = Buffer.from(JSON.stringify(snapshot), "utf8");
  if (data.length !== bytes || data.length > EXECUTION_RESULT_MAX_BYTES)
    throw limitError();
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (args.expectedSha256 !== undefined && args.expectedSha256 !== sha256)
    throw Error("执行记录摘要不匹配或已变更");
  if (args.offsetBytes > data.length) throw Error("执行结果分块偏移超出范围");
  const chunk = data.subarray(
    args.offsetBytes,
    args.offsetBytes + args.maxBytes,
  );
  const nextOffsetBytes = args.offsetBytes + chunk.length;
  return {
    version: 1,
    projectId: args.projectId,
    runId: args.runId,
    encoding: "base64",
    mediaType: "application/json",
    sha256,
    offsetBytes: args.offsetBytes,
    chunkBytes: chunk.length,
    totalBytes: data.length,
    nextOffsetBytes,
    eof: nextOffsetBytes === data.length,
    data: chunk.toString("base64"),
  };
}
