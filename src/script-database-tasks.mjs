import {
  normalizeNativeAssertionData,
  isNativeVariableAssertion,
} from "./native-response-assertions.mjs";
import {
  nativeDataArray,
  nativeDataObject,
  normalizePickVarsData,
} from "./native-response-extraction.mjs";
import { mongoQuery } from "./mongodb.mjs";
import { redisCommand } from "./redis.mjs";
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
          ![
            "connectionId",
            "query",
            "variables",
            "isConsoleOutput",
            "resultShape",
          ].includes(key),
      ) ||
      (entry.resultShape !== undefined &&
        !["mysql-resultsets", "redis-value", "mongodb-document"].includes(
          entry.resultShape,
        )) ||
      !name(entry.connectionId) ||
      typeof entry.query !== "string" ||
      !entry.query.trim() ||
      entry.query.length > 50000 ||
      /\{\{/.test(entry.query) ||
      (!["redis-value", "mongodb-document"].includes(entry.resultShape) &&
        !/^\s*(SELECT|WITH)\b/i.test(entry.query)) ||
      ![-1, 0, 1].includes(entry.isConsoleOutput) ||
      !Array.isArray(entry.variables) ||
      entry.variables.length > 100
    )
      throw Error("数据库任务仅支持显式连接、静态只读SQL和有界提取；不插值SQL");
    let query = entry.query;
    if (entry.resultShape === "redis-value") {
      const command = redisCommand({ sql: query });
      if (
        !["GET", "HGET", "EXISTS"].includes(command[0]) ||
        (command[0] === "EXISTS" && command.length !== 2)
      )
        throw Error("原生Redis任务仅支持单键GET/HGET/EXISTS只读标量查询");
      query = JSON.stringify(command);
    }
    if (entry.resultShape === "mongodb-document") {
      const normalized = mongoQuery({ sql: query });
      if (normalized.limit !== 1 || normalized.skip !== 0)
        throw Error("原生MongoDB任务只支持limit=1、skip=0的单文档查找");
      query = JSON.stringify(normalized);
    }
    return {
      ...(entry.resultShape !== undefined
        ? { resultShape: entry.resultShape }
        : {}),
      connectionId: entry.connectionId,
      query,
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
export function databaseResultRows(operation, result) {
  if (!object(result) || !Array.isArray(result.rows))
    throw Error("数据库任务结果缺少rows");
  if (operation.resultShape === "redis-value") {
    if (
      result.rows.length !== 1 ||
      !object(result.rows[0]) ||
      !Object.hasOwn(result.rows[0], "value") ||
      !(
        result.rows[0].value === null ||
        ["string", "number"].includes(typeof result.rows[0].value)
      )
    )
      throw Error(
        "Redis任务需要一个文本、数值或null结果；不解析JSON文本或二进制对象",
      );
    return result.rows[0].value;
  }
  if (operation.resultShape === "mongodb-document") {
    if (
      result.format !== "extended-json" ||
      result.rows.length > 1 ||
      (result.rows.length === 1 && !object(result.rows[0]))
    )
      throw Error("MongoDB任务需要单个Extended JSON文档或空结果");
    // The shared driver probes one extra match; findone intentionally selects
    // one document, so truncated=true is not an extraction failure.
    return result.rows.length ? result.rows[0] : null;
  }
  return operation.resultShape === "mysql-resultsets"
    ? [result.rows]
    : result.rows;
}
export function databaseAssignments(operation, result) {
  const rows = databaseResultRows(operation, result);
  // Validate all extractions before applying any changes in the sandbox.
  return operation.variables.map((variable) => {
    let value = rows;
    // Native scalar database results assign directly. Retain the path as
    // provenance, but do not index strings into characters or expose .length.
    for (const key of operation.resultShape === "redis-value" ||
    (operation.resultShape === "mongodb-document" && rows === null)
      ? []
      : jsonPathSegments(variable.pattern)) {
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

export function normalizeNativeTaskRequest(request) {
  if (request.nativeTasks === undefined) return undefined;
  const source = request.nativeTasks;
  if (
    !object(source) ||
    Object.keys(source).some(
      (key) => !["version", "before", "after"].includes(key),
    ) ||
    source.version !== 1
  )
    throw Error("原版执行任务版本或字段无效");
  if (
    request.inheritSharedScripts !== false ||
    ["beforeScript", "afterScript"].some((key) => request[key]) ||
    ["before", "after", "sharedBeforeScripts", "sharedAfterScripts"].some(
      (key) => request[key]?.length,
    )
  )
    throw Error("原版执行任务不能与旧操作或共享脚本混用；须明确关闭共享继承");
  const result = { version: 1 };
  for (const phase of ["before", "after"]) {
    const tasks = source[phase];
    nativeDataArray(tasks, 16);
    if (!Array.isArray(tasks) || tasks.length > 16)
      throw Error("原版任务阶段最多16项");
    let bytes = 0,
      databases = 0;
    result[phase] = tasks.map((task) => {
      nativeDataObject(task, [
        "type",
        "enabled",
        "data",
        "id",
        "name",
        "origin",
      ]);
      if (
        !object(task) ||
        Object.keys(task).some(
          (key) =>
            !["type", "enabled", "data", "id", "name", "origin"].includes(key),
        ) ||
        ![1, 0, -1].includes(task.enabled) ||
        !["customScript", "database", "pickVars", "assert"].includes(task.type)
      )
        throw Error("原版执行任务配置无效");
      for (const key of ["id", "name"])
        if (task[key] !== undefined && !name(task[key]))
          throw Error("原版执行任务标识无效");
      if (task.origin !== undefined)
        nativeDataObject(task.origin, ["scope", "id"]);
      if (
        task.origin !== undefined &&
        (!object(task.origin) ||
          Object.keys(task.origin).some(
            (key) => !["scope", "id"].includes(key),
          ) ||
          !["project", "folder", "request", "sample"].includes(
            task.origin.scope,
          ) ||
          !name(task.origin.id))
      )
        throw Error("原版任务作用域来源无效");
      let data;
      if (task.type === "customScript") {
        if (
          typeof task.data !== "string" ||
          (bytes += Buffer.byteLength(task.data)) > 65536
        )
          throw Error("任务脚本合计最多64KiB");
        data = task.data;
      } else if (task.type === "assert") {
        data = normalizeNativeAssertionData(task.data, {
          enabled: task.enabled === 1,
        });
        if (
          task.enabled === 1 &&
          phase !== "after" &&
          !isNativeVariableAssertion(data.type)
        )
          throw Error("启用响应断言仅支持后置响应阶段");
      } else if (task.type === "pickVars") {
        if (task.enabled === 1 && phase !== "after")
          throw Error("启用pickVars仅支持后置响应阶段");
        data = normalizePickVarsData(task.data, {
          enabled: task.enabled === 1,
        });
      } else {
        data = normalizeDatabaseOperations([task.data])[0];
        if (task.enabled === 1 && ++databases > 5)
          throw Error("数据库任务每阶段最多5项");
      }
      return {
        type: task.type,
        enabled: task.enabled,
        data,
        ...(task.origin !== undefined
          ? { origin: structuredClone(task.origin) }
          : {}),
        ...(task.id !== undefined ? { id: task.id } : {}),
        ...(task.name !== undefined ? { name: task.name } : {}),
      };
    });
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 262144)
    throw Error("原版执行任务合计最多256KiB");
  return result;
}
