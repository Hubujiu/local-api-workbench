export const apipostFunctionSourceGroups = Object.freeze({
  "apipost-function": "query",
  "apipost-header-function": "headers",
  "apipost-form-function": "form",
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
  const match = /^\{\{\$function\.(fn_[A-Za-z0-9_]+)\(([^(){}|]*)\)\}\}$/.exec(
    value,
  );
  if (!match) throw Error("仅支持完整的原版函数模板，不支持嵌套、拼接或加工链");
  return { name: match[1].toLowerCase(), argument: match[2] };
}
export function validateApipostTemplateRequest(request) {
  const entries = [];
  for (const group of ["query", "headers", "path", "cookies", "form"]) {
    if (request[group] !== undefined && !Array.isArray(request[group]))
      throw Error(group + " 必须是对象数组");
    for (const row of request[group] || [])
      if (row?.dynamic) entries.push({ group, row });
  }
  const bodyTemplate = Object.values(request.bodyDynamic || {}).some((spec) =>
    isApipostFunctionSource(spec?.source),
  );
  if (
    !bodyTemplate &&
    !entries.some(({ row }) => isApipostFunctionSource(row.dynamic.source))
  )
    return;
  if (
    entries.some(
      ({ group, row }) =>
        !isApipostFunctionSource(row.dynamic.source) ||
        group !== apipostFunctionSourceGroups[row.dynamic.source] ||
        row.type === "file",
    ) ||
    Object.keys(request.bodyDynamic || {}).length
  )
    throw Error(
      "原版函数模板暂仅支持Query/Header/表单匹配位置文本，不能与其他动态值混用",
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
    parseApipostFunctionTemplate(row.dynamic.value);
    if (row.dynamic.functions?.length)
      throw Error("原版函数模板暂不支持额外加工链");
    if (row.enabled !== false) count++;
  }
  if (count > 20) throw Error("每个请求最多20次动态函数处理");
}
