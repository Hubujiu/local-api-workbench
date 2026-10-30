import { createHash } from "node:crypto";
import { redisWriteCommand } from "./redis.mjs";

const plain = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const invalid = () =>
  Object.assign(Error("原生写入仅支持静态单键 Redis SET"), {
    code: "NATIVE_WRITE_INTENT_INVALID",
  });

// Inert intent only: this module cannot grant permission or dispatch a command.
export function nativeRedisSetCommand(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value[0] !== "SET" ||
    value.some(
      (part) =>
        typeof part !== "string" || !part.isWellFormed() || part.includes("{{"),
    )
  )
    throw invalid();
  try {
    return redisWriteCommand({ command: value, allowWrite: true });
  } catch {
    throw invalid();
  }
}
export function importedRedisSet(value) {
  if (
    !plain(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "key") ||
    !Object.hasOwn(value, "value")
  )
    throw invalid();
  return JSON.stringify(nativeRedisSetCommand(["SET", value.key, value.value]));
}
export function normalizeNativeRedisSetQuery(query) {
  if (typeof query !== "string" || query.length > 50000) throw invalid();
  let parsed;
  try {
    parsed = JSON.parse(query);
  } catch {
    throw invalid();
  }
  return JSON.stringify(nativeRedisSetCommand(parsed));
}
export function nativeWriteDigest(value) {
  function stable(item) {
    if (Array.isArray(item)) return item.map(stable);
    if (plain(item))
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, stable(item[key])]),
      );
    return item;
  }
  return createHash("sha256")
    .update("native-write-v1\n")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
export function collectNativeRedisWrites(request) {
  const result = [];
  for (const phase of ["before", "after"]) {
    for (const [ordinal, task] of (
      request.nativeTasks?.[phase] || []
    ).entries()) {
      if (
        task.type !== "database" ||
        task.enabled !== 1 ||
        task.data?.writeIntent !== "redis-set"
      )
        continue;
      const query = normalizeNativeRedisSetQuery(task.data.query);
      result.push({
        phase,
        ordinal,
        ...(task.id ? { taskId: task.id } : {}),
        connectionId: task.data.connectionId,
        query,
        commandDigest: nativeWriteDigest(JSON.parse(query)),
      });
    }
  }
  return result;
}
export function denyNativeWrites(requests) {
  if (requests.some((request) => collectNativeRedisWrites(request).length))
    throw Object.assign(Error("原生 Redis 写入须使用所有者单次授权入口"), {
      code: "NATIVE_WRITE_AUTHORITY_REQUIRED",
    });
}
