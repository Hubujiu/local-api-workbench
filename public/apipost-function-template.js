export const apipostBuiltinStages = Object.freeze([
  "lower",
  "upper",
  "length",
  "number",
]);
export const isApipostBuiltinStage = (name) =>
  apipostBuiltinStages.includes(name);
export const apipostFunctionSourceGroups = Object.freeze({
  "apipost-function": "query",
  "apipost-header-function": "headers",
  "apipost-form-function": "form",
  "apipost-body-function": "body",
});
export const isApipostFunctionSource = (source) =>
  typeof source === "string" &&
  Object.hasOwn(apipostFunctionSourceGroups, source);
export function parseApipostFunctionTemplate(value) {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > 65536
  )
    throw Error("原版函数模板须为不超过64KiB的文本");
  const match =
    /^\{\{\$function\.(fn_[A-Za-z0-9_]+)\(([^(){}|]*)\)((?:\|[A-Za-z_][A-Za-z0-9_]*)*)\}\}$/.exec(
      value,
    );
  if (!match)
    throw Error("仅支持完整原版函数模板及白名单无参数加工链，不支持嵌套或拼接");
  const pipeline = match[3]
    ? match[3]
        .slice(1)
        .split("|")
        .map((name) => name.toLowerCase())
    : [];
  if (
    pipeline.some(
      (name) =>
        !/^fn_[A-Za-z0-9_]+$/.test(name) && !isApipostBuiltinStage(name),
    )
  )
    throw Error("原版加工链仅支持无参数fn_或lower/upper/length/number");
  if (pipeline.length > 9) throw Error("每个原版函数模板最多10个函数阶段");
  return {
    name: match[1].toLowerCase(),
    argument: match[2],
    ...(pipeline.length ? { pipeline } : {}),
  };
}
export function validateApipostTemplateRequest(request) {
  const entries = [];
  for (const group of ["query", "headers", "path", "cookies", "form"]) {
    if (request[group] !== undefined && !Array.isArray(request[group]))
      throw Error(group + " 必须是对象数组");
    for (const row of request[group] || [])
      if (row?.dynamic) entries.push({ group, row });
  }
  const definitions = Object.entries(request.bodyDynamic || {});
  if (
    !entries.some(({ row }) => isApipostFunctionSource(row.dynamic.source)) &&
    !definitions.some(([, spec]) => isApipostFunctionSource(spec?.source))
  )
    return;
  if (definitions.length) {
    const [key, spec] = definitions[0];
    if (
      definitions.length !== 1 ||
      spec?.source !== "apipost-body-function" ||
      spec.format !== "text" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(key) ||
      !["raw", "json"].includes(request.bodyType) ||
      request.body !== "{{@value:" + key + "}}"
    )
      throw Error(
        "原版函数模板仅支持Query/Header/表单或raw/json完整正文；正文须为单个原文输出模板",
      );
    entries.push({ group: "body", row: { dynamic: spec } });
  }
  if (
    entries.some(
      ({ group, row }) =>
        !isApipostFunctionSource(row.dynamic.source) ||
        group !== apipostFunctionSourceGroups[row.dynamic.source] ||
        row.type === "file",
    )
  )
    throw Error(
      "原版函数模板暂仅支持Query/Header/表单/正文匹配位置文本，不能与其他动态值混用",
    );
  if (
    entries.some(
      ({ group, row }) => group === "form" && row.enabled !== false,
    ) &&
    !["urlencoded", "form-data"].includes(request.bodyType)
  )
    throw Error("原版表单函数模板仅支持urlencoded或form-data文本字段");
  if (
    (request.scriptURLMode && request.scriptURLMode !== "string") ||
    request.beforeScript?.trim() ||
    request.afterScript?.trim() ||
    request.sharedBeforeScripts?.length ||
    request.sharedAfterScripts?.length ||
    request.before?.length ||
    request.after?.length
  )
    throw Error("原版函数模板暂不支持SDK URL模式或前后置脚本/操作组合");
  let count = 0;
  for (const { row } of entries) {
    const parsed = parseApipostFunctionTemplate(row.dynamic.value);
    if (row.dynamic.functions?.length)
      throw Error("原版函数模板暂不支持额外加工链");
    if (row.enabled !== false) count += 1 + (parsed.pipeline?.length || 0);
  }
  if (count > 20) throw Error("每个请求最多20次动态函数处理");
}
