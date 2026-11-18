import { validateApipostDatabaseResources } from "./apipost-database-import.mjs";
import { mongoQuery } from "./mongodb.mjs";
import {
  nativeDataArray,
  nativeDataObject,
} from "./native-response-extraction.mjs";

// A deliberate credential-free rebind profile, not lossless connection export.
// No session/grant/provider is consulted. Nothing here connects to a database.
export function readDatabaseExportMode(options) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    throw Error("数据库导出选项必须是普通对象");
  const property = Object.getOwnPropertyDescriptor(options, "databaseMode");
  if (
    (property && (!property.enumerable || !("value" in property))) ||
    (!property && "databaseMode" in options)
  )
    throw Error("数据库导出模式不接受访问器或继承属性");
  return property?.value;
}
export function prepareApipostDatabaseExport(project, mode, projectId, id) {
  if (mode !== undefined && mode !== "rebind")
    throw Error("数据库导出模式仅支持显式 rebind");
  const settings = project.settings || {};
  const property = Object.getOwnPropertyDescriptor(
    settings,
    "apipostDatabases",
  );
  if (
    (property && (!property.enumerable || !("value" in property))) ||
    (!property && "apipostDatabases" in settings)
  )
    throw Error("数据库导出目录不接受访问器或继承属性");
  const entries = property?.value ?? [];
  nativeDataArray(entries, 100);
  for (const entry of entries)
    nativeDataObject(entry, [
      "id",
      "name",
      "type",
      "sourceProjectId",
      "sourceId",
      "requiresSSH",
      "sort",
    ]);
  validateApipostDatabaseResources(entries);
  if (entries.length && mode !== "rebind")
    throw Error(
      "数据库定义出口须显式 databaseMode=rebind；不导出连接凭据，请重新授权",
    );
  const connections = new Map();
  const records = entries.map((entry, index) => {
    if (
      !["postgres", "mysql", "redis", "mongodb"].includes(entry.type) ||
      entry.requiresSSH !== undefined
    )
      throw Error(
        "数据库重绑定出口支持无 SSH 的 PostgreSQL、MySQL、Redis 和 MongoDB 目录",
      );
    const dbId = id("db", entry.id);
    connections.set(entry.id, { id: dbId, type: entry.type });
    return {
      db_id: dbId,
      project_id: projectId,
      name: entry.name,
      type: entry.type === "postgres" ? "pg" : entry.type,
      sort: entry.sort ?? index,
      intro:
        "Workbench credential-free rebind profile. Connection settings omitted; explicitly configure and authorize before execution.",
      config: {
        default: {
          db_config: {
            host: "",
            port: { postgres: 5432, mysql: 3306, redis: 6379, mongodb: 27017 }[
              entry.type
            ],
            user: "",
            password: "",
            database: "",
            auth_source: "",
          },
          ssh: {
            enable: -1,
            auth_type: 1,
            host: "",
            port: 22,
            username: "",
            password: "",
            private_key: "",
            passphrase: "",
          },
        },
      },
    };
  });
  return { enabled: mode === "rebind", connections, records, id };
}
export function exportApipostDatabaseTask(
  task,
  context,
  requestId,
  phase,
  index,
) {
  const connection =
    context?.enabled && context.connections.get(task.data.connectionId);
  if (!connection)
    throw Error("数据库任务出口缺少显式重绑目录或连接引用；请使用项目备份");
  const shape = task.data.resultShape;
  if (
    (connection.type === "mysql" && shape !== "mysql-resultsets") ||
    (connection.type === "postgres" && shape !== undefined) ||
    (connection.type === "redis" && shape !== "redis-value") ||
    (connection.type === "mongodb" && shape !== "mongodb-document") ||
    task.data.writeIntent !== undefined
  )
    throw Error("数据库任务结果形状或写入意图不能无损转为此重绑定义");
  const scopes = {
    environment: "environment",
    global: "globals",
    temporary: "variables",
  };
  let operation = { query: task.data.query };
  if (connection.type === "redis") {
    const command = JSON.parse(task.data.query);
    if (
      !Array.isArray(command) ||
      !["GET", "HGET", "EXISTS"].includes(command[0]) ||
      command.length !== (command[0] === "HGET" ? 3 : 2) ||
      command
        .slice(1)
        .some(
          (v) =>
            typeof v !== "string" ||
            !v.isWellFormed() ||
            Buffer.byteLength(v) > 4096,
        )
    )
      throw Error("Redis 原生重绑定只支持单键 GET、HGET 和 EXISTS");
    operation = {
      method: command[0].toLowerCase(),
      query: JSON.stringify({
        key: command[1],
        ...(command.length === 3 && { field: command[2] }),
      }),
    };
  } else if (connection.type === "mongodb") {
    const query = mongoQuery({ sql: task.data.query });
    if (
      query.limit !== 1 ||
      query.skip !== 0 ||
      Object.keys(query.sort).length ||
      Object.keys(query.projection).length
    )
      throw Error("MongoDB 原生 findone 要求单条、无排序、投影或偏移的查询");
    operation = {
      method: "findone",
      collectionName: query.collection,
      query: JSON.stringify(query.filter),
    };
  }
  return {
    ...task,
    data: {
      connectionId: connection.id,
      ...operation,
      isConsoleOutput: task.data.isConsoleOutput,
      variables: task.data.variables.map((row, rowIndex) => ({
        name: row.name,
        type: scopes[row.type],
        pattern: row.pattern,
        param_id: context.id(
          "dv",
          requestId + "\0" + phase + "\0" + index + "\0" + rowIndex,
        ),
      })),
    },
  };
}
