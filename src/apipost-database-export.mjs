import { validateApipostDatabaseResources } from "./apipost-database-import.mjs";
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
      !["postgres", "mysql"].includes(entry.type) ||
      entry.requiresSSH !== undefined
    )
      throw Error("数据库重绑定出口仅支持无SSH的PostgreSQL/MySQL目录");
    const dbId = id("db", entry.id);
    connections.set(entry.id, { id: dbId, type: entry.type });
    return {
      db_id: dbId,
      project_id: projectId,
      name: entry.name,
      type: entry.type === "postgres" ? "pg" : "mysql",
      sort: entry.sort ?? index,
      intro:
        "Workbench credential-free rebind profile. Connection settings omitted; explicitly configure and authorize before execution.",
      config: {
        default: {
          db_config: {
            host: "",
            port: entry.type === "postgres" ? 5432 : 3306,
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
    task.data.writeIntent !== undefined
  )
    throw Error("数据库任务结果形状或写入意图不能无损转为此重绑定义");
  const scopes = {
    environment: "environment",
    global: "globals",
    temporary: "variables",
  };
  return {
    ...task,
    data: {
      connectionId: connection.id,
      query: task.data.query,
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
