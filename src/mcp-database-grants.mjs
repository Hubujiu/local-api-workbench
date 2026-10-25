import { DatabaseSessions } from "./database-sessions.mjs";
const fields = new Set([
  "name",
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
  "bindingId",
]);
/** Explicit MCP-only grants: never share manual sessions or persist configuration. */
export class MCPDatabaseGrants {
  #sessions = new DatabaseSessions();
  #epoch = 0;
  #policy;
  constructor(policy) {
    this.#policy = policy;
  }
  capture() {
    return this.#epoch;
  }
  invalidate() {
    this.#epoch++;
    this.#sessions.close();
  }
  assertProject(projectId, epoch = this.#epoch) {
    const policy = this.#policy();
    if (
      epoch !== this.#epoch ||
      !policy.enabled ||
      !policy.write ||
      !policy.execute ||
      !policy.projects.includes(projectId)
    )
      throw Error("MCP 数据库权限未授权或已撤销");
  }
  register(project, input, epoch = this.#epoch) {
    this.assertProject(project.id, epoch);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !fields.has(key))
    )
      throw Error("MCP 数据库只接受临时只读连接配置，不接受写入或持久授权字段");
    if (input.bindingId !== undefined) {
      const source = project.settings?.apipostDatabases?.find(
        (item) => item.id === input.bindingId,
      );
      if (!source || source.type !== input.type)
        throw Error("MCP 数据库绑定须匹配当前项目来源和数据库类型");
    }
    return this.#sessions.register(project.id, input);
  }
  list(projectId, epoch = this.#epoch) {
    this.assertProject(projectId, epoch);
    return this.#sessions.list(projectId);
  }
  revoke(projectId, id, epoch = this.#epoch) {
    this.assertProject(projectId, epoch);
    this.#sessions.revoke(projectId, id);
  }
  async query(epoch, projectId, operation, signal) {
    const check = () => {
      this.assertProject(projectId, epoch);
      if (
        !this.#sessions
          .list(projectId)
          .some(
            (item) =>
              item.id === operation.connectionId ||
              item.bindingId === operation.connectionId,
          )
      )
        throw Error("MCP 数据库权限未授权或已撤销");
    };
    check();
    try {
      const result = await this.#sessions.query(projectId, operation, signal);
      check();
      return result;
    } catch (error) {
      check();
      if (signal?.aborted) throw Error("MCP 数据库操作已取消");
      const code =
        typeof error.code === "string" &&
        (/^[A-Z0-9]{5}$/.test(error.code) ||
          ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET"].includes(
            error.code,
          ))
          ? " (" + error.code + ")"
          : "";
      throw Error("MCP 数据库只读查询失败" + code);
    }
  }
}
