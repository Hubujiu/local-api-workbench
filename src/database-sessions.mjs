import { randomUUID } from "node:crypto";
import { querySQLiteBounded } from "./database.mjs";
import { queryRemoteDatabase } from "./remote-database.mjs";

// Explicit ephemeral grants. Connection secrets are never written into projects.
export class DatabaseSessions {
  #connections = new Map();
  register(projectId, input) {
    if (this.#connections.size >= 20)
      throw Error("会话数据库连接最多20个，请先撤销不用的连接");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error("连接配置无效");
    const type = input.type || "sqlite";
    if (!["sqlite", "postgres", "mysql", "redis", "mongodb"].includes(type))
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
    if (Buffer.byteLength(JSON.stringify(config)) > 131072)
      throw Error("连接配置最多128KiB");
    const id = randomUUID();
    this.#connections.set(id, { projectId, name: input.name.trim(), config });
    return { id, name: input.name.trim(), type };
  }
  list(projectId) {
    return [...this.#connections]
      .filter(([, item]) => item.projectId === projectId)
      .map(([id, item]) => ({ id, name: item.name, type: item.config.type }));
  }
  revoke(projectId, id) {
    if (this.#connections.get(id)?.projectId !== projectId)
      throw Error("数据库会话连接不存在或不属于此项目");
    this.#connections.delete(id);
  }
  async query(projectId, operation, signal) {
    if (signal?.aborted) throw Error("数据库操作已取消");
    const item = this.#connections.get(operation.connectionId);
    if (!item || item.projectId !== projectId)
      throw Error("数据库会话连接已失效或未授权给此项目，请重新配置");
    const config = structuredClone(item.config);
    const result =
      config.type === "sqlite"
        ? await querySQLiteBounded(
            config.filename,
            operation.sql,
            operation.parameters,
          )
        : await queryRemoteDatabase({
            ...config,
            sql: operation.sql,
            parameters: operation.parameters,
          });
    if (signal?.aborted) throw Error("数据库操作已取消");
    if (this.#connections.get(operation.connectionId) !== item)
      throw Error("数据库会话连接已撤销，结果未应用");
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
      throw Error("数据库结果超过1MiB");
    return result;
  }
  close() {
    this.#connections.clear();
  }
}
