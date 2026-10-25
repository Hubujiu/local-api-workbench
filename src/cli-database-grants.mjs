import { DatabaseSessions } from "./database-sessions.mjs";
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fields = new Set([
  "type",
  "filename",
  "host",
  "port",
  "user",
  "password",
  "database",
  "ca",
  "authSource",
  "ssl",
  "ssh",
]);
/** Explicit stdin-only grants for this invocation; never persisted in a plan. */
export function prepareCLIDatabaseGrants(projectId, plan, connections) {
  if (!plain(connections) || Object.keys(connections).length > 20)
    throw Error("CLI 数据库连接映射无效或超过20项");
  const required = new Set();
  for (const step of plan.steps) {
    if (step.enabled === false || !step.request) continue;
    for (const phase of ["before", "after"])
      for (const operation of step.request[phase] || []) {
        if (operation.type !== "database" || operation.enabled === false)
          continue;
        if (
          typeof operation.connectionId !== "string" ||
          !operation.connectionId
        )
          throw Error("CLI 数据库操作缺少连接标识");
        required.add(operation.connectionId);
      }
  }
  if (
    Object.keys(connections).some((key) => !required.has(key)) ||
    [...required].some((key) => !Object.hasOwn(connections, key))
  )
    throw Error("CLI 数据库映射必须恰好匹配启用计划的数据库连接标识");
  const sessions = new DatabaseSessions(),
    bindings = new Map();
  try {
    for (const id of required) {
      const config = connections[id];
      if (!plain(config) || Object.keys(config).some((key) => !fields.has(key)))
        throw Error("CLI 数据库连接字段无效；不接受写入或持久授权选项");
      if (
        ![
          "sqlite",
          "postgres",
          "mysql",
          "redis",
          "mongodb",
          "clickhouse",
        ].includes(config.type)
      )
        throw Error("CLI 数据库连接必须显式指定支持的类型");
      if (
        config.type !== "sqlite" &&
        (typeof config.host !== "string" || !config.host.trim())
      )
        throw Error("CLI 远程数据库连接必须显式指定主机");
      if (
        config.type !== "sqlite" &&
        (typeof config.database !== "string" || !config.database.trim())
      )
        throw Error("CLI 远程数据库连接必须显式指定数据库");
      if (config.type !== "sqlite" && Object.hasOwn(config, "filename"))
        throw Error("CLI 远程数据库不接受本地文件路径");
      if (config.type !== "mongodb" && Object.hasOwn(config, "authSource"))
        throw Error("CLI authSource 仅适用于 MongoDB");
      if (
        config.type === "sqlite" &&
        Object.keys(config).some((key) => !["type", "filename"].includes(key))
      )
        throw Error("CLI SQLite 连接仅接受类型和显式文件路径");
      bindings.set(
        id,
        sessions.register(projectId, { ...config, name: "CLI transient" }).id,
      );
    }
  } catch (error) {
    sessions.close();
    throw error;
  }
  let closed = false;
  return {
    query(operation, signal) {
      if (closed || !bindings.has(operation.connectionId))
        return Promise.reject(Error("CLI 数据库连接未获本次授权或已关闭"));
      return sessions.query(
        projectId,
        { ...operation, connectionId: bindings.get(operation.connectionId) },
        signal,
      );
    },
    close() {
      closed = true;
      bindings.clear();
      sessions.close();
    },
  };
}
