import {
  normalizeNativeWaitData,
  compileNativeWaits,
} from "./native-wait-tasks.mjs";
import { normalizeNativeAssertionData } from "./native-response-assertions.mjs";
import { normalizePickVarsData } from "./native-response-extraction.mjs";
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
export function prepareCLIDatabaseGrants(
  projectId,
  plan,
  connections,
  sourceCatalog = [],
) {
  if (!Array.isArray(sourceCatalog) || sourceCatalog.length > 100)
    throw Error("CLI 数据库来源目录无效");
  const sourceTypes = new Map(),
    sshRequired = new Set();
  for (const source of sourceCatalog) {
    if (
      !plain(source) ||
      typeof source.id !== "string" ||
      sourceTypes.has(source.id) ||
      ![
        "postgres",
        "mysql",
        "redis",
        "mongodb",
        "sqlite",
        "clickhouse",
      ].includes(source.type)
    )
      throw Error("CLI 数据库来源标识或类型无效");
    if (
      source.requiresSSH !== undefined &&
      (source.requiresSSH !== true ||
        !["postgres", "mysql"].includes(source.type))
    )
      throw Error("CLI 数据库SSH来源要求无效");
    if (source.requiresSSH === true) sshRequired.add(source.id);
    sourceTypes.set(source.id, source.type);
  }
  const inferredTypes = new Map();
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
  for (const step of plan.steps) {
    if (step.enabled === false || step.request?.nativeTasks === undefined)
      continue;
    const tasks = step.request.nativeTasks;
    if (
      !plain(tasks) ||
      tasks.version !== 1 ||
      Object.keys(tasks).some(
        (key) => !["version", "before", "after"].includes(key),
      )
    )
      throw Error("CLI 原版数据库任务格式无效");
    for (const phase of ["before", "after"]) {
      if (!Array.isArray(tasks[phase]) || tasks[phase].length > 16)
        throw Error("CLI 原版任务阶段最多16项");
      const waits = [];
      for (const task of tasks[phase]) {
        if (
          !plain(task) ||
          ![1, 0, -1].includes(task.enabled) ||
          !["customScript", "database", "pickVars", "assert", "wait"].includes(
            task.type,
          )
        )
          throw Error("CLI 原版任务启停或类型无效");
        if (task.type === "pickVars") {
          normalizePickVarsData(task.data, { enabled: task.enabled === 1 });
          if (phase === "before" && task.enabled === 1)
            throw Error("CLI pickVars仅支持后置响应阶段");
        }
        if (task.type === "assert") {
          normalizeNativeAssertionData(task.data, {
            enabled: task.enabled === 1,
          });
          if (phase === "before" && task.enabled === 1)
            throw Error("CLI原生断言仅支持后置响应阶段");
        }
        if (task.type === "wait") {
          normalizeNativeWaitData(task.data, { enabled: task.enabled === 1 });
          if (task.enabled === 1) waits.push(task.data);
        }
        if (task.type !== "database" || task.enabled !== 1) continue;
        if (
          !plain(task.data) ||
          typeof task.data.connectionId !== "string" ||
          !task.data.connectionId ||
          task.data.connectionId.length > 200
        )
          throw Error("CLI 原版数据库任务缺少连接标识");
        required.add(task.data.connectionId);
        const engine =
          task.data.resultShape === "redis-value"
            ? "redis"
            : task.data.resultShape === "mysql-resultsets"
              ? "mysql"
              : task.data.resultShape === "mongodb-document"
                ? "mongodb"
                : undefined;
        if (engine) {
          if (
            inferredTypes.has(task.data.connectionId) &&
            inferredTypes.get(task.data.connectionId) !== engine
          )
            throw Error("CLI 数据库任务对同一连接声明了不同引擎");
          inferredTypes.set(task.data.connectionId, engine);
        }
      }
      compileNativeWaits(waits);
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
        (sourceTypes.has(id) && sourceTypes.get(id) !== config.type) ||
        (inferredTypes.has(id) && inferredTypes.get(id) !== config.type) ||
        (/^apipost-[a-f0-9]{20}-db-[a-f0-9]{20}$/.test(id) &&
          !sourceTypes.has(id))
      )
        throw Error("CLI 数据库授权必须匹配当前项目来源及任务引擎");
      if (
        sourceTypes.get(id) === "mongodb" &&
        config.user &&
        (typeof config.authSource !== "string" || !config.authSource.trim())
      )
        throw Error("CLI 导入MongoDB认证须明确authSource");
      if (sshRequired.has(id) && !config.ssh)
        throw Error("CLI 此数据库来源要求显式SSH临时通道和已核对主机指纹");
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
