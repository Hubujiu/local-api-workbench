// Historical comparison data, never a second executable request or MCP grant.
// Step IDs describe the import-time snapshot, not the current plan's step order.
const forbidden = ["__proto__", "prototype", "constructor"];
function text(value, max) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    Buffer.byteLength(value, "utf8") > max
  )
    throw Error("原生计划来源文本无效或超过上限");
  return value;
}
function identifier(value) {
  text(value, 200);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value) || forbidden.includes(value))
    throw Error("原生计划来源标识无效");
  return value;
}
function plain(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("原生计划来源须为普通对象");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1000) throw Error("原生计划来源对象字段过多");
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      forbidden.includes(key) ||
      (allowed && !allowed.includes(key)) ||
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    )
      throw Error("原生计划来源包含未知字段或访问器");
    text(key, 1000);
  }
  return keys;
}
function array(value, max) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw Error("原生计划来源数组无效或超过上限");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let i = 0; i < value.length; i++)
    if (!descriptors[i]?.enumerable || !Object.hasOwn(descriptors[i], "value"))
      throw Error("原生计划来源数组不能有空洞或访问器");
  return value;
}
function baselineInput(value) {
  plain(value, ["body", "query", "path", "headers", "cookies", "auth"]);
  let nodes = 0,
    bytes = 0;
  const visit = (v, depth = 0) => {
    if (++nodes > 5000 || depth > 20)
      throw Error("原生计划来源JSON超过节点或深度上限");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      text(v, 65536);
      bytes += Buffer.byteLength(v, "utf8");
      if (bytes > 65536) throw Error("原生计划来源输入最多64KiB");
      return v;
    }
    if (Array.isArray(v)) return array(v, 1000).map((x) => visit(x, depth + 1));
    return Object.fromEntries(
      plain(v).map((key) => [key, visit(v[key], depth + 1)]),
    );
  };
  const result = visit(value);
  for (const key of ["query", "path", "headers", "cookies"])
    if (Object.hasOwn(result, key)) plain(result[key]);
  if (Object.hasOwn(result, "auth")) {
    plain(result.auth, ["type"]);
    if (!["noauth", "none"].includes(result.auth.type))
      throw Error("原生计划历史认证仅支持显式无需认证；不保留凭证或授权配置");
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 65536)
    throw Error("原生计划来源输入最多64KiB");
  return result;
}
export function normalizeImportedNativeFlowSource(value) {
  plain(value, [
    "version",
    "source",
    "sourceProjectId",
    "sourceFlowId",
    "mcp_name",
    "mcp_description",
    "mcp_environment_id",
    "steps",
  ]);
  if (value.version !== 1 || !["manual", "ai", "mcp"].includes(value.source))
    throw Error("原生计划来源版本或来源无效");
  const result = {
    version: 1,
    source: value.source,
    sourceProjectId: identifier(value.sourceProjectId),
    sourceFlowId: identifier(value.sourceFlowId),
  };
  for (const [key, max] of [
    ["mcp_name", 800],
    ["mcp_description", 40000],
    ["mcp_environment_id", 800],
  ])
    if (Object.hasOwn(value, key)) result[key] = text(value[key], max);
  const nativeIds = new Set(),
    importedIds = new Set();
  let bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  result.steps = array(value.steps, 200).map((step) => {
    plain(step, [
      "sourceStepId",
      "importedStepId",
      "mcp_input",
      "mcp_deleted_body_keys",
    ]);
    const row = {
      sourceStepId: identifier(step.sourceStepId),
      importedStepId: identifier(step.importedStepId),
    };
    if (nativeIds.has(row.sourceStepId) || importedIds.has(row.importedStepId))
      throw Error("原生计划来源步骤标识重复");
    nativeIds.add(row.sourceStepId);
    importedIds.add(row.importedStepId);
    if (Object.hasOwn(step, "mcp_input"))
      row.mcp_input = baselineInput(step.mcp_input);
    if (Object.hasOwn(step, "mcp_deleted_body_keys")) {
      row.mcp_deleted_body_keys = array(step.mcp_deleted_body_keys, 1000).map(
        (key) => text(key, 1000),
      );
      if (
        Buffer.byteLength(JSON.stringify(row.mcp_deleted_body_keys), "utf8") >
        65536
      )
        throw Error("原生计划历史删除键最多64KiB");
    }
    bytes += Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (bytes > 4 * 1024 * 1024) throw Error("原生计划来源合计最多4MiB");
    return row;
  });
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 4 * 1024 * 1024)
    throw Error("原生计划来源合计最多4MiB");
  return result;
}
// Inspect the property before reading it or cloning its owning plan.
export function readImportedNativeFlowSource(plan) {
  const d = Object.getOwnPropertyDescriptor(plan, "importedNativeFlowSource");
  if (!d) return undefined;
  if (!d.enumerable || !Object.hasOwn(d, "value"))
    throw Error("原生计划来源属性不能包含访问器或隐藏字段");
  return d.value === undefined
    ? undefined
    : normalizeImportedNativeFlowSource(d.value);
}
