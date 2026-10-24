import { Worker } from "node:worker_threads";
import { databaseParameters } from "./database-values.mjs";
import { remoteConnectionConfig } from "./remote-database.mjs";
import { openDatabaseSSH } from "./database-ssh.mjs";
const active = new Set();
export const mysqlWriteUsage = () => ({ active: active.size, limit: 5 });
export function parseMySQLWrite(sql, database) {
  if (
    typeof database !== "string" ||
    !database.trim() ||
    database.length > 64 ||
    database.includes("\0")
  )
    return Promise.reject(Error("MySQL数据库名称无效"));
  if (
    typeof sql !== "string" ||
    !sql.trim() ||
    sql.length > 50000 ||
    /[\0\\#]/.test(sql) ||
    sql.includes("/*") ||
    sql.includes("--")
  )
    return Promise.reject(
      Error("MySQL写入SQL须为有界单条语句，不支持注释或反斜杠，请使用绑定参数"),
    );
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./mysql-write-parser.mjs", import.meta.url),
      {
        workerData: { sql, database },
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 2 },
        execArgv: [],
      },
    );
    let done = false;
    const finish = async (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        await worker.terminate();
      } catch {}
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(Error("MySQL SQL解析超时")), 2000);
    worker.once("message", (m) =>
      finish(m?.ok ? null : Error(m?.error || "MySQL SQL解析失败"), m?.value),
    );
    worker.once("error", () => finish(Error("MySQL SQL解析失败")));
    worker.once("exit", () => {
      if (!done) finish(Error("MySQL SQL解析进程提前退出"));
    });
  });
}
export async function mutateMySQL(input, dependencies = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.type !== "mysql" ||
    input.allowWrite !== true
  )
    throw Error("MySQL写入需要本次明确授权");
  for (const name of ["host", "user", "database"])
    if (
      typeof input[name] !== "string" ||
      !input[name].trim() ||
      input[name].length > (name === "database" ? 64 : 255) ||
      input[name].includes("\0")
    )
      throw Error("请明确填写MySQL主机、数据库和用户");
  if (
    input.port !== undefined &&
    (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
  )
    throw Error("MySQL端口无效");
  if (input.ssl !== undefined && typeof input.ssl !== "boolean")
    throw Error("MySQL TLS标识无效");
  const parameters = databaseParameters(
    input.parameters === undefined ? [] : input.parameters,
    "mysql",
  );
  const timeoutMs = dependencies.queryTimeoutMs ?? 2000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 2000)
    throw Error("MySQL写入时限无效");
  if (active.size >= 5) throw Error("最多同时执行5个MySQL写入");
  const lease = {};
  active.add(lease);
  const connections = [],
    tunnels = [];
  let connection,
    control,
    begun = false,
    committing = false,
    timer,
    cancelPromise;
  const timeoutError = () =>
    Error(
      "MySQL写入超时，未发出提交，已尝试取消本次查询并关闭连接；请核实数据及触发器副作用，不要盲目重试",
    );
  try {
    const statement = await parseMySQLWrite(input.sql, input.database);
    const mysql = await import("mysql2/promise");
    const createConnection =
      dependencies.createConnection || mysql.createConnection;
    const open = async () => {
      const tunnel = await openDatabaseSSH(input);
      if (tunnel) tunnels.push(tunnel);
      const c = await createConnection({
        ...remoteConnectionConfig(input),
        ...(tunnel ? { stream: tunnel.stream } : {}),
        connectTimeout: 3000,
        multipleStatements: false,
        flags: ["FOUND_ROWS"],
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
        decimalNumbers: false,
        rowsAsArray: true,
      });
      c.on?.("error", () => {});
      connections.push(c);
      return c;
    };
    connection = await open();
    control = await open();
    if (
      !Number.isSafeInteger(connection.threadId) ||
      connection.threadId < 1 ||
      connection.threadId > 0xffffffff
    )
      throw Error("无法确认本次MySQL会话标识");
    const command = (sql) => connection.query({ sql, timeout: 2000 });
    await command("SET TRANSACTION READ WRITE");
    await command("START TRANSACTION");
    begun = true;
    // Acquire a transaction-held metadata lock before inspecting the storage engine.
    await command(
      `SELECT 1 FROM ${mysql.escapeId(statement.schema, true)}.${mysql.escapeId(statement.table, true)} LIMIT 0`,
    );
    const [tables] = await connection.execute(
      {
        sql: "SELECT ENGINE, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=? LIMIT 2",
        timeout: 2000,
      },
      [statement.schema, statement.table],
    );
    if (
      tables.length !== 1 ||
      tables[0][0] !== "InnoDB" ||
      tables[0][1] !== "BASE TABLE"
    )
      throw Error("MySQL受限写入仅支持可确认的InnoDB基础表");
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        cancelPromise = (async () => {
          try {
            await control.query({
              sql: `KILL QUERY ${connection.threadId}`,
              timeout: 1000,
            });
          } catch {
          } finally {
            connection.destroy();
            control.destroy();
          }
        })();
        cancelPromise.then(
          () => reject(timeoutError()),
          () => reject(timeoutError()),
        );
      }, timeoutMs);
    });
    const [result] = await Promise.race([
      connection.execute(statement.sql, parameters),
      deadline,
    ]);
    clearTimeout(timer);
    if (cancelPromise) {
      await cancelPromise;
      throw timeoutError();
    }
    if (
      !result ||
      Array.isArray(result) ||
      !Number.isSafeInteger(result.affectedRows) ||
      result.affectedRows < 0 ||
      result.affectedRows > 1000
    )
      throw Error("MySQL写入目标行数无效或超过1000行");
    if (result.warningStatus !== 0)
      throw Error("MySQL写入产生警告，拒绝静默截断或转换");
    committing = true;
    await command("COMMIT");
    begun = false;
    return {
      columns: [],
      rows: [],
      affectedRows: result.affectedRows,
      committed: true,
      truncated: false,
      limit: 1000,
    };
  } catch (error) {
    clearTimeout(timer);
    if (cancelPromise) {
      await cancelPromise;
      throw timeoutError();
    }
    if (committing)
      throw Error(
        "提交结果未确认，请先查询数据，不要盲目重试：" + error.message,
      );
    if (begun) {
      try {
        await connection.query({ sql: "ROLLBACK", timeout: 2000 });
      } catch {
        throw Error(
          "写入失败且未收到回滚确认；请核实数据和触发器副作用，不要盲目重试",
        );
      }
      throw Error(
        "MySQL事务已回滚（不保证自增计数、触发器、级联或非事务性外部副作用）：" +
          error.message,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    for (const c of connections) c.destroy();
    for (const t of tunnels) t.close();
    active.delete(lease);
  }
}
