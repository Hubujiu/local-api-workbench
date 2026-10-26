import { jsonPathSegments } from "./json-path.mjs";
import { validateMockResponse } from "../public/response-example.js";
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const scalarTypes = new Set(["string", "number", "integer", "boolean", "null"]);
export function nativeMockScalarText(value, type) {
  const valid =
    type === "null"
      ? value === null
      : type === "integer"
        ? Number.isInteger(value)
        : type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : type === "string"
            ? typeof value === "string" && value.isWellFormed()
            : type === "boolean" && typeof value === "boolean";
  if (!valid) throw Error("原版Mock标量结果与声明根类型不一致");
  return value === null ? "" : String(value);
}
export const nativeMockOperations = new Set([
  "eq",
  "uneq",
  "gt",
  "gte",
  "lt",
  "lte",
  "includes",
  "unincludes",
  "null",
  "notnull",
  "exist",
  "notexist",
  "regularmatch",
  "belongscollection",
  "notbelongscollection",
]);
export function nativeRegex(value) {
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    !value.startsWith("/") ||
    value.lastIndexOf("/") < 1
  )
    throw Error("Mock正则须为/表达式/flags，最多2000字符");
  const end = value.lastIndexOf("/"),
    flags = value.slice(end + 1);
  if (!/^[gimsuy]*$/.test(flags) || new Set(flags).size !== flags.length)
    throw Error("Mock正则flags不支持或重复");
  return { pattern: value.slice(1, end), flags };
}
export function normalizeNativeMock(value) {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        !["version", "enabled", "rules", "fallback", "sourceTargetId"].includes(
          key,
        ),
    ) ||
    value.version !== 1 ||
    typeof value.enabled !== "boolean" ||
    typeof value.sourceTargetId !== "string" ||
    !value.sourceTargetId ||
    value.sourceTargetId.length > 200 ||
    !Array.isArray(value.rules) ||
    value.rules.length > 100
  )
    throw Error("原版Mock定义无效");
  if (Buffer.byteLength(JSON.stringify(value)) > 1048576)
    throw Error("原版Mock定义最多1MiB");
  let regexes = 0;
  const response = (entry) => {
    if (
      !object(entry) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "status",
            "sourceStatus",
            "body",
            "schema",
            "headers",
            "delayMs",
            "serialization",
          ].includes(key),
      ) ||
      entry.status !== 200 ||
      !Number.isInteger(entry.sourceStatus) ||
      entry.sourceStatus < 200 ||
      entry.sourceStatus > 599
    )
      throw Error("原版Mock仅支持已验证的固定200策略");
    validateMockResponse({ ...entry, body: entry.body ?? "" });
    if ((entry.schema === undefined) === (typeof entry.body !== "string"))
      throw Error("原版Mock响应须明确选择Schema或文本");
    if (
      entry.serialization !== undefined &&
      !["scalar-text", "raw-xml"].includes(entry.serialization)
    )
      throw Error("原版Mock响应序列化策略不支持");
    if (entry.serialization === "raw-xml") {
      if (entry.schema !== undefined || typeof entry.body !== "string")
        throw Error("原版XML Mock仅支持明确原始文本，不支持Schema生成");
    } else if (entry.serialization === "scalar-text") {
      if (!object(entry.schema) || !scalarTypes.has(entry.schema.type))
        throw Error("原版标量Mock需要明确单一根类型");
      // Mirror the existing sampler's literal priority without sampling or
      // executing anything during import. Derived values are checked at runtime.
      for (const key of ["const", "example", "default"])
        if (entry.schema[key] !== undefined) {
          nativeMockScalarText(entry.schema[key], entry.schema.type);
          return structuredClone(entry);
        }
      if (entry.schema.enum?.length)
        nativeMockScalarText(entry.schema.enum[0], entry.schema.type);
    } else if (
      entry.schema !== undefined &&
      (!object(entry.schema) ||
        !["object", "array"].includes(entry.schema.type))
    )
      throw Error("原版Schema Mock标量根需要明确序列化策略");
    return structuredClone(entry);
  };
  const rules = value.rules.map((rule) => {
    if (
      !object(rule) ||
      Object.keys(rule).some(
        (key) =>
          !["id", "name", "enabled", "conditions", "response"].includes(key),
      ) ||
      typeof rule.id !== "string" ||
      !rule.id ||
      rule.id.length > 200 ||
      typeof rule.name !== "string" ||
      rule.name.length > 200 ||
      typeof rule.enabled !== "boolean" ||
      !Array.isArray(rule.conditions) ||
      rule.conditions.length > 50
    )
      throw Error("原版Mock规则格式无效");
    const conditions = rule.conditions.map((condition) => {
      if (
        !object(condition) ||
        Object.keys(condition).some(
          (key) => !["path", "op", "value"].includes(key),
        ) ||
        typeof condition.path !== "string" ||
        condition.path.length > 1000 ||
        !/^\$\.(query|headers|body)(\.|\[)/.test(condition.path) ||
        !nativeMockOperations.has(condition.op) ||
        !Object.hasOwn(condition, "value") ||
        !(
          condition.value === null ||
          ["string", "boolean", "number"].includes(typeof condition.value)
        ) ||
        (typeof condition.value === "number" &&
          !Number.isFinite(condition.value)) ||
        (typeof condition.value === "string" && condition.value.length > 65536)
      )
        throw Error("原版Mock条件无效");
      jsonPathSegments(condition.path);
      if (condition.op === "regularmatch") {
        nativeRegex(condition.value);
        if (rule.enabled && ++regexes > 16)
          throw Error("原版Mock启用正则最多16项");
      }
      return structuredClone(condition);
    });
    return {
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      conditions,
      response: response(rule.response),
    };
  });
  return {
    version: 1,
    enabled: value.enabled,
    sourceTargetId: value.sourceTargetId,
    rules,
    fallback: response(value.fallback),
  };
}
