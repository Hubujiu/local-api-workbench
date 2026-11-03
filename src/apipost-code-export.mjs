import { isDeepStrictEqual, types } from "node:util";
import { validateErrorCodes } from "./error-codes.mjs";
import { mergeApipostCodes } from "./apipost-codes.mjs";

function record(value, allowed) {
  if (
    !value ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("原生状态码导出仅支持普通数据对象");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value))
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    )
      throw Error("原生状态码导出包含未知字段或访问器");
}

function validateDefinitions(rows) {
  if (
    types.isProxy(rows) ||
    !Array.isArray(rows) ||
    Object.getPrototypeOf(rows) !== Array.prototype ||
    rows.length > 2000
  )
    throw Error("原生状态码导出最多2000项普通数组");
  const descriptors = Object.getOwnPropertyDescriptors(rows);
  if (Reflect.ownKeys(rows).length !== rows.length + 1)
    throw Error("原生状态码数组包含非数据字段");
  for (let i = 0; i < rows.length; i++) {
    if (!descriptors[i]?.enumerable || !Object.hasOwn(descriptors[i], "value"))
      throw Error("原生状态码数组不能包含空洞或访问器");
    const row = descriptors[i].value;
    record(row, ["code", "label", "httpHint", "apipostSource"]);
    if (row.httpHint === true)
      throw Error("原生状态码不能表达HTTP提示开关；请使用项目备份");
    if (Object.is(row.code, -0))
      throw Error("原生状态码JSON不能精确保留负零；请使用项目备份");
    if (row.apipostSource !== undefined) {
      const origin = row.apipostSource;
      record(origin, ["projectId", "codeId"]);
      if (
        typeof origin.projectId !== "string" ||
        !origin.projectId.trim() ||
        origin.projectId.length > 200 ||
        ["__proto__", "prototype", "constructor"].includes(origin.projectId) ||
        (origin.codeId !== undefined &&
          (typeof origin.codeId !== "string" ||
            !origin.codeId.trim() ||
            origin.codeId.length > 200))
      )
        throw Error("原生状态码历史来源格式无效");
    }
  }
  return validateErrorCodes(rows);
}

const definitions = (rows) =>
  validateDefinitions(rows).map(({ code, label }) => ({ code, label }));

export function verifyApipostCodeDefinitions(expected = [], actual = []) {
  if (!isDeepStrictEqual(definitions(expected), definitions(actual)))
    throw Error("原生状态码导出回读不一致");
}

export function exportApipostCodes(rows = []) {
  // Historical source identity is checked, not minted as a new native identity.
  const output = definitions(rows).map(({ code, label }) => ({
    code_number: code,
    code_msg: label,
  }));
  // Verify the serialized representation, not just an in-memory inverse map.
  const restored = mergeApipostCodes(JSON.parse(JSON.stringify(output)));
  verifyApipostCodeDefinitions(rows, restored);
  return output;
}
