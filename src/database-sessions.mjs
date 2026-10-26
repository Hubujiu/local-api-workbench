import { explicitPostgresOptions } from "./postgres-client.mjs";
import { databaseSSHConfig } from "./database-ssh.mjs";
import { randomUUID } from "node:crypto";
import { querySQLiteBounded } from "./database.mjs";
import { queryRemoteDatabase } from "./remote-database.mjs";

export function assertDatabaseBindingRequirements(source, config) {
  if (
    !source ||
    source.type !== config.type ||
    (source.requiresSSH !== undefined && source.requiresSSH !== true)
  )
    throw Error("导入数据库来源或类型已变化，须重新核对授权");
  if (
    source.type === "mongodb" &&
    config.user &&
    (typeof config.authSource !== "string" || !config.authSource.trim())
  )
    throw Error(
      "导入MongoDB认证须显式指定当前authSource，不继承原配置或猜测默认认证库",
    );
  if (source.requiresSSH === true && !config.ssh)
    throw Error("此导入数据库要求SSH，须显式配置已核对主机指纹的临时通道");
}

// Explicit ephemeral grants. Connection secrets are never written into projects.
export class DatabaseSessions {
  #connections = new Map();
  #resolveProject;
  constructor({ resolveProject } = {}) {
    if (resolveProject !== undefined && typeof resolveProject !== "function")
      throw Error("数据库项目来源解析器无效");
    this.#resolveProject = resolveProject;
  }
  async #checkSource(projectId, item) {
    if (!item.bindingId || !this.#resolveProject) return;
    let project;
    try {
      project = await this.#resolveProject(projectId);
    } catch {
      throw Error("当前项目数据库来源不可核对，查询或结果应用已拒绝");
    }
    const catalog = project?.settings?.apipostDatabases;
    if (
      project?.id !== projectId ||
      !Array.isArray(catalog) ||
      catalog.length > 100
    )
      throw Error("当前项目数据库来源目录无效");
    const matches = catalog.filter((source) => source?.id === item.bindingId);
    if (matches.length !== 1) throw Error("当前项目数据库来源已移除或不唯一");
    assertDatabaseBindingRequirements(matches[0], item.config);
  }
  register(projectId, input) {
    if (this.#connections.size >= 20)
      throw Error("会话数据库连接最多20个，请先撤销不用的连接");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error("连接配置无效");
    const type = input.type || "sqlite";
    if (
      ![
        "sqlite",
        "postgres",
        "mysql",
        "redis",
        "mongodb",
        "clickhouse",
      ].includes(type)
    )
      throw Error("数据库类型无效");
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 100
    )
      throw Error("连接名称须为1至100字符");
    const config = { type };
    for (const key of [
      "filename",
      "host",
      "user",
      "password",
      "database",
      "ca",
      "authSource",
    ])
      if (input[key] !== undefined) {
        if (typeof input[key] !== "string" || input[key].length > 65536)
          throw Error("连接字段无效: " + key);
        config[key] = input[key];
      }
    if (type === "sqlite" && !config.filename?.trim())
      throw Error("数据库路径为空");
    if (input.port !== undefined && input.port !== 0) {
      if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
        throw Error("数据库端口无效");
      config.port = input.port;
    }
    if (input.ssl !== undefined && typeof input.ssl !== "boolean")
      throw Error("TLS选项必须为布尔值");
    config.ssl = input.ssl === true;
    if (type === "postgres") explicitPostgresOptions(config);
    if (input.ssh !== undefined) {
      if (!["postgres", "mysql"].includes(type))
        throw Error("SSH 通道目前仅支持 PostgreSQL/MySQL");
      config.ssh = databaseSSHConfig(input.ssh);
    }
    if (Buffer.byteLength(JSON.stringify(config)) > 131072)
      throw Error("连接配置最多128KiB");
    const bindingId = input.bindingId;
    if (
      bindingId !== undefined &&
      (typeof bindingId !== "string" ||
        !/^apipost-[a-f0-9]{20}-db-[a-f0-9]{20}$/.test(bindingId) ||
        [...this.#connections.values()].some(
          (item) =>
            item.projectId === projectId && item.bindingId === bindingId,
        ))
    )
      throw Error("导入数据库绑定标识无效或已授权；请先撤销旧会话");
    const id = randomUUID();
    this.#connections.set(id, {
      projectId,
      name: input.name.trim(),
      config,
      bindingId,
    });
    return {
      id,
      name: input.name.trim(),
      type,
      ...(bindingId ? { bindingId } : {}),
    };
  }
  list(projectId) {
    return [...this.#connections]
      .filter(([, item]) => item.projectId === projectId)
      .map(([id, item]) => ({
        id,
        name: item.name,
        type: item.config.type,
        ...(item.bindingId ? { bindingId: item.bindingId } : {}),
      }));
  }
  revoke(projectId, id) {
    if (this.#connections.get(id)?.projectId !== projectId)
      throw Error("数据库会话连接不存在或不属于此项目");
    this.#connections.delete(id);
  }
  async query(projectId, operation, signal) {
    if (signal?.aborted) throw Error("数据库操作已取消");
    const resolvedId = this.#connections.has(operation.connectionId)
      ? operation.connectionId
      : [...this.#connections].find(
          ([, item]) =>
            item.projectId === projectId &&
            item.bindingId === operation.connectionId,
        )?.[0];
    const item = this.#connections.get(resolvedId);
    if (!item || item.projectId !== projectId)
      throw Error("数据库会话连接已失效或未授权给此项目，请重新配置");
    await this.#checkSource(projectId, item);
    if (signal?.aborted) throw Error("数据库操作已取消");
    if (this.#connections.get(resolvedId) !== item)
      throw Error("数据库会话连接已撤销");
    const config = structuredClone(item.config);
    const result =
      config.type === "sqlite"
        ? await querySQLiteBounded(
            config.filename,
            operation.sql,
            operation.parameters,
          )
        : await queryRemoteDatabase(
            {
              ...config,
              sql: operation.sql,
              parameters: operation.parameters,
            },
            { signal },
          );
    await this.#checkSource(projectId, item);
    if (signal?.aborted) throw Error("数据库操作已取消");
    if (this.#connections.get(resolvedId) !== item)
      throw Error("数据库会话连接已撤销，结果未应用");
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
      throw Error("数据库结果超过1MiB");
    return result;
  }
  close() {
    this.#connections.clear();
  }
}
