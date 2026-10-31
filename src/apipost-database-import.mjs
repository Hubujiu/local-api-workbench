import { normalizeNativeWaitData } from "./native-wait-tasks.mjs";
import { normalizeNativeAssertionData } from "./native-response-assertions.mjs";
import {
  nativeDataArray,
  nativeDataObject,
  normalizePickVarsData,
} from "./native-response-extraction.mjs";
import { mongoQuery } from "./mongodb.mjs";
import { normalizeNativeTaskRequest } from "./script-database-tasks.mjs";
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const safe = (value) =>
  typeof value === "string" &&
  value.trim() &&
  value.length <= 200 &&
  !["__proto__", "prototype", "constructor"].includes(value);
export function prepareApipostDatabases(value, projectId, resource) {
  if (value === undefined || value === null || value === "") value = [];
  if (!Array.isArray(value) || value.length > 100)
    throw Error("Apipost数据库连接目录最多100项");
  if (Buffer.byteLength(JSON.stringify(value)) > 1048576)
    throw Error("Apipost数据库来源目录最多1MiB");
  const map = new Map(),
    connections = [];
  for (const entry of value) {
    if (
      !object(entry) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "config",
            "db_id",
            "intro",
            "name",
            "project_id",
            "type",
            "sort",
          ].includes(key),
      ) ||
      (entry.sort !== undefined && !Number.isSafeInteger(entry.sort)) ||
      entry.project_id !== projectId ||
      !["pg", "mysql", "redis", "mongodb"].includes(entry.type) ||
      !safe(entry.db_id) ||
      !safe(entry.name) ||
      typeof entry.intro !== "string" ||
      entry.intro.length > 8000 ||
      !object(entry.config) ||
      !object(entry.config.default) ||
      Object.keys(entry.config).length > 101 ||
      map.has(entry.db_id)
    )
      throw Error(
        "Apipost数据库连接仅支持同项目PostgreSQL/MySQL/Redis/MongoDB定义，不会丢弃未知语义",
      );
    for (const [environment, config] of Object.entries(entry.config)) {
      if (
        !safe(environment) ||
        !object(config) ||
        Object.keys(config).some(
          (key) => !["db_config", "ssh", "use_default"].includes(key),
        ) ||
        (environment !== "default" && config.use_default !== 1)
      )
        throw Error("Apipost数据库独立环境配置尚未支持，须明确继承默认连接");
      const db = config.db_config,
        ssh = config.ssh;
      if (
        !object(db) ||
        Object.keys(db).some(
          (key) =>
            ![
              "auth_source",
              "database",
              "host",
              "password",
              "port",
              "user",
            ].includes(key),
        ) ||
        typeof db.port !== "number" ||
        !Number.isInteger(db.port) ||
        db.port < 0 ||
        db.port > 65535
      )
        throw Error("Apipost数据库配置无效");
      for (const key of ["auth_source", "database", "host", "password", "user"])
        if (typeof db[key] !== "string" || db[key].length > 65536)
          throw Error("Apipost数据库配置文本无效");
      if (db.auth_source && entry.type !== "mongodb")
        throw Error("此数据库不支持auth_source");
      if (entry.type === "mongodb" && db.auth_source.length > 128)
        throw Error("MongoDB来源认证库最多128字符");
      if (
        !object(ssh) ||
        Object.keys(ssh).some(
          (key) =>
            ![
              "auth_type",
              "enable",
              "host",
              "passphrase",
              "password",
              "port",
              "private_key",
              "username",
            ].includes(key),
        ) ||
        ![-1, 0, 1].includes(ssh.enable) ||
        (ssh.enable === 1 && !["pg", "mysql"].includes(entry.type)) ||
        ![1, 2].includes(ssh.auth_type) ||
        !Number.isInteger(ssh.port) ||
        ssh.port < 0 ||
        ssh.port > 65535
      )
        throw Error("Apipost数据库SSH配置尚未支持");
      for (const key of [
        "host",
        "passphrase",
        "password",
        "private_key",
        "username",
      ])
        if (typeof ssh[key] !== "string" || ssh[key].length > 65536)
          throw Error("Apipost数据库SSH字段无效");
    }
    const connection = {
      id: resource("db", entry.db_id),
      name: entry.name,
      type: entry.type === "pg" ? "postgres" : entry.type,
      sourceProjectId: projectId,
      sourceId: entry.db_id,
      ...(entry.sort !== undefined ? { sort: entry.sort } : {}),
      ...(entry.config.default.ssh.enable === 1 ? { requiresSSH: true } : {}),
    };
    map.set(entry.db_id, connection.id);
    connections.push(connection);
  }
  return { map, connections };
}
export function nativeDatabaseTasks(
  tasks,
  map,
  { translated = false, connections = [], phase = "before" } = {},
) {
  nativeDataArray(tasks, 16);
  if (!Array.isArray(tasks) || tasks.length > 16)
    throw Error("Apipost任务阶段最多16项");
  if (!["before", "after"].includes(phase)) throw Error("原版任务阶段无效");
  const output = tasks.map((task) => {
    nativeDataObject(task, ["type", "enabled", "data", "id", "name", "origin"]);
    if (
      !object(task) ||
      !safe(task.id) ||
      !safe(task.name) ||
      (!translated && task.origin !== undefined)
    )
      throw Error("Apipost任务无效");
    if (task.type === "wait")
      normalizeNativeWaitData(task.data, { enabled: task.enabled === 1 });
    if (task.type === "assert")
      normalizeNativeAssertionData(task.data, { enabled: task.enabled === 1 });
    if (task.type === "pickVars")
      normalizePickVarsData(task.data, { enabled: task.enabled === 1 });
    const next = structuredClone(task);
    if (task.type === "database") {
      if (
        !object(task.data) ||
        (!translated && Object.hasOwn(task.data, "resultShape")) ||
        !(translated
          ? [...map.values()].includes(task.data.connectionId)
          : map.has(task.data.connectionId))
      )
        throw Error("Apipost数据库任务引用不存在的连接");
      const scopes = translated
        ? {
            environment: "environment",
            global: "global",
            temporary: "temporary",
          }
        : {
            environment: "environment",
            globals: "global",
            variables: "temporary",
          };
      if (
        !Array.isArray(task.data.variables) ||
        task.data.variables.some(
          (variable) =>
            !object(variable) || !Object.hasOwn(scopes, variable.type),
        )
      )
        throw Error("原版数据库变量作用域无效");
      next.data.variables = task.data.variables.map((variable) => ({
        ...variable,
        type: scopes[variable.type],
      }));
      next.data.connectionId = translated
        ? task.data.connectionId
        : map.get(task.data.connectionId);
      const sourceType = connections.find(
        (c) => c.id === next.data.connectionId,
      )?.type;
      if (sourceType === "mysql") next.data.resultShape = "mysql-resultsets";
      if (sourceType === "mongodb") {
        if (!translated) {
          if (
            task.data.method !== "findone" ||
            typeof task.data.query !== "string" ||
            task.data.query.length > 50000
          )
            throw Error("原版MongoDB任务仅支持findone和有界JSON筛选文本");
          let filter;
          try {
            filter = JSON.parse(task.data.query);
          } catch {
            throw Error("原版MongoDB筛选须为JSON对象文本");
          }
          if (!object(filter)) throw Error("原版MongoDB筛选须为JSON对象");
          next.data.query = JSON.stringify(
            mongoQuery({
              query: { collection: task.data.collectionName, filter, limit: 1 },
            }),
          );
          delete next.data.method;
          delete next.data.collectionName;
        }
        next.data.resultShape = "mongodb-document";
      }
      if (sourceType === "redis") {
        if (!translated) {
          const method = task.data.method;
          if (
            !["get", "hget", "exists"].includes(method) ||
            typeof task.data.query !== "string" ||
            task.data.query.length > 50000
          )
            throw Error("原版Redis任务仅支持GET/HGET/EXISTS及有界JSON对象参数");
          let args;
          try {
            args = JSON.parse(task.data.query);
          } catch {
            throw Error("原版Redis参数必须是JSON对象文本");
          }
          const keys = method === "hget" ? ["key", "field"] : ["key"];
          if (
            !object(args) ||
            Object.keys(args).length !== keys.length ||
            Object.keys(args).some((key) => !keys.includes(key)) ||
            keys.some(
              (key) =>
                typeof args[key] !== "string" ||
                !args[key].isWellFormed() ||
                Buffer.byteLength(args[key]) > 4096,
            )
          )
            throw Error("原版Redis查询参数字段无效");
          next.data.query = JSON.stringify([
            method.toUpperCase(),
            ...keys.map((key) => args[key]),
          ]);
          delete next.data.method;
        }
        next.data.resultShape = "redis-value";
      }
    }
    return next;
  });
  return normalizeNativeTaskRequest({
    inheritSharedScripts: false,
    nativeTasks: {
      version: 1,
      before: phase === "before" ? output : [],
      after: phase === "after" ? output : [],
    },
  })[phase];
}
export function validateApipostDatabaseResources(value = []) {
  if (!Array.isArray(value) || value.length > 100)
    throw Error("导入数据库目录最多100项");
  const ids = new Set();
  for (const entry of value) {
    if (
      !object(entry) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "id",
            "name",
            "type",
            "sourceProjectId",
            "sourceId",
            "requiresSSH",
            "sort",
          ].includes(key),
      ) ||
      !/^apipost-[a-f0-9]{20}-db-[a-f0-9]{20}$/.test(entry.id) ||
      ids.has(entry.id) ||
      !safe(entry.name) ||
      !["postgres", "mysql", "redis", "mongodb"].includes(entry.type) ||
      !safe(entry.sourceProjectId) ||
      !safe(entry.sourceId) ||
      (entry.sort !== undefined && !Number.isSafeInteger(entry.sort)) ||
      (entry.requiresSSH !== undefined &&
        (entry.requiresSSH !== true ||
          !["postgres", "mysql"].includes(entry.type)))
    )
      throw Error("导入数据库目录只保留安全标识，不允许连接配置或凭据");
    ids.add(entry.id);
  }
}
