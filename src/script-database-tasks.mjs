import { jsonPathSegments } from "./json-path.mjs";

const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const name = (value) =>
  typeof value === "string" &&
  value.trim() &&
  value.length <= 200 &&
  !["__proto__", "prototype", "constructor"].includes(value);
export function normalizeDatabaseOperations(value = []) {
  if (!Array.isArray(value) || value.length > 5)
    throw Error("数据库任务每阶段最多5项");
  return value.map((entry) => {
    if (
      !object(entry) ||
      Object.keys(entry).some(
        (key) =>
          !["connectionId", "query", "variables", "isConsoleOutput"].includes(
            key,
          ),
      ) ||
      !name(entry.connectionId) ||
      typeof entry.query !== "string" ||
      !entry.query.trim() ||
      entry.query.length > 50000 ||
      /\{\{/.test(entry.query) ||
      !/^\s*(SELECT|WITH)\b/i.test(entry.query) ||
      ![-1, 0, 1].includes(entry.isConsoleOutput) ||
      !Array.isArray(entry.variables) ||
      entry.variables.length > 100
    )
      throw Error("数据库任务仅支持显式连接、静态只读SQL和有界提取；不插值SQL");
    return {
      connectionId: entry.connectionId,
      query: entry.query,
      isConsoleOutput: entry.isConsoleOutput,
      variables: entry.variables.map((variable) => {
        if (
          !object(variable) ||
          Object.keys(variable).some(
            (key) => !["name", "param_id", "pattern", "type"].includes(key),
          ) ||
          !name(variable.name) ||
          (variable.param_id !== undefined && !name(variable.param_id)) ||
          !["environment", "global", "temporary"].includes(variable.type) ||
          typeof variable.pattern !== "string" ||
          variable.pattern.length > 1000
        )
          throw Error("数据库任务结果提取无效");
        jsonPathSegments(variable.pattern);
        return {
          name: variable.name,
          type: variable.type,
          pattern: variable.pattern,
        };
      }),
    };
  });
}
export function databaseAssignments(operation, result) {
  if (!object(result) || !Array.isArray(result.rows))
    throw Error("数据库任务结果缺少rows");
  // Validate all extractions before applying any changes in the sandbox.
  return operation.variables.map((variable) => {
    let value = result.rows;
    for (const key of jsonPathSegments(variable.pattern)) {
      if (
        value === null ||
        value === undefined ||
        !Object.hasOwn(Object(value), key)
      )
        throw Error("数据库结果提取路径不存在");
      value = value[key];
    }
    if (value === undefined) throw Error("数据库结果提取路径不存在");
    return {
      name: variable.name,
      type: variable.type,
      value: structuredClone(value),
    };
  });
}
