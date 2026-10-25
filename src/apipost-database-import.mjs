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
          !["config", "db_id", "intro", "name", "project_id", "type"].includes(
            key,
          ),
      ) ||
      entry.project_id !== projectId ||
      entry.type !== "pg" ||
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
        "Apipost数据库连接仅支持同项目PostgreSQL定义，不会丢弃未知语义",
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
      if (db.auth_source) throw Error("PostgreSQL auth_source不支持");
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
        ![-1, 0].includes(ssh.enable) ||
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
      type: "postgres",
      sourceProjectId: projectId,
      sourceId: entry.db_id,
    };
    map.set(entry.db_id, connection.id);
    connections.push(connection);
  }
  return { map, connections };
}
export function nativeDatabaseTasks(tasks, map, { translated = false } = {}) {
  if (!Array.isArray(tasks) || tasks.length > 16)
    throw Error("Apipost任务阶段最多16项");
  const output = tasks.map((task) => {
    if (
      !object(task) ||
      !safe(task.id) ||
      !safe(task.name) ||
      (!translated && task.origin !== undefined)
    )
      throw Error("Apipost任务无效");
    const next = structuredClone(task);
    if (task.type === "database") {
      if (
        !object(task.data) ||
        !(translated
          ? [...map.values()].includes(task.data.connectionId)
          : map.has(task.data.connectionId))
      )
        throw Error("Apipost数据库任务引用不存在的连接");
      if (
        !Array.isArray(task.data.variables) ||
        task.data.variables.some((variable) => variable.type !== "environment")
      )
        throw Error(
          "原版数据库变量类型目前仅验收environment，不猜测其他序列化值",
        );
      next.data.connectionId = translated
        ? task.data.connectionId
        : map.get(task.data.connectionId);
    }
    return next;
  });
  return normalizeNativeTaskRequest({
    inheritSharedScripts: false,
    nativeTasks: { version: 1, before: output, after: [] },
  }).before;
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
          !["id", "name", "type", "sourceProjectId", "sourceId"].includes(key),
      ) ||
      !/^apipost-[a-f0-9]{20}-db-[a-f0-9]{20}$/.test(entry.id) ||
      ids.has(entry.id) ||
      !safe(entry.name) ||
      entry.type !== "postgres" ||
      !safe(entry.sourceProjectId) ||
      !safe(entry.sourceId)
    )
      throw Error("导入数据库目录只保留安全标识，不允许连接配置或凭据");
    ids.add(entry.id);
  }
}
