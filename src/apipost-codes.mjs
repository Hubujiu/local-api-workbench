import { validateErrorCodes } from "./error-codes.mjs";

// Static modern-export fields; no code execution or HTTP-status inference.
export function mergeApipostCodes(rows = [], existing = [], projectId) {
  if (!Array.isArray(rows) || rows.length > 2000)
    throw Error("Apipost错误码字典最多2000项");
  const entries = Object.getOwnPropertyDescriptors(rows);
  if (
    Object.getPrototypeOf(rows) !== Array.prototype ||
    Reflect.ownKeys(rows).length !== rows.length + 1
  )
    throw Error("Apipost错误码数组须为连续普通数组");
  for (let i = 0; i < rows.length; i++)
    if (!entries[i]?.enumerable || !Object.hasOwn(entries[i], "value"))
      throw Error("Apipost错误码数组不能包含空洞或访问器");
  validateErrorCodes(existing);
  const ids = new Set();
  const incoming = rows.map((row) => {
    if (!row || ![Object.prototype, null].includes(Object.getPrototypeOf(row)))
      throw Error("Apipost错误码须为普通对象");
    const descriptors = Object.getOwnPropertyDescriptors(row);
    for (const key of Reflect.ownKeys(row))
      if (
        typeof key !== "string" ||
        !["code_id", "project_id", "code_number", "code_msg"].includes(key) ||
        !descriptors[key].enumerable ||
        !Object.hasOwn(descriptors[key], "value")
      )
        throw Error("Apipost错误码包含未知字段或访问器");
    if (row.project_id !== undefined && row.project_id !== projectId)
      throw Error("Apipost错误码项目来源不匹配");
    let source;
    if (row.code_id !== undefined) {
      if (
        typeof row.code_id !== "string" ||
        !row.code_id.trim() ||
        row.code_id.length > 200 ||
        ids.has(row.code_id)
      )
        throw Error("Apipost错误码标识无效或重复");
      ids.add(row.code_id);
      source = { projectId, codeId: row.code_id };
    } else if (row.project_id !== undefined) source = { projectId };
    return {
      code: row.code_number,
      label: row.code_msg,
      ...(source ? { apipostSource: source } : {}),
    };
  });
  validateErrorCodes(incoming);
  const result = structuredClone(existing);
  const byCode = new Map(result.map((item) => [String(item.code), item]));
  for (const item of incoming) {
    const previous = byCode.get(String(item.code));
    if (previous) {
      // Never overwrite a user's dictionary or opt them into HTTP-status hints.
      if (previous.label !== item.label)
        throw Error("Apipost错误码字典同码说明冲突，请导入新项目");
      continue;
    }
    result.push(item);
    byCode.set(String(item.code), item);
  }
  return validateErrorCodes(result);
}
