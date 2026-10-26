import { Worker } from "node:worker_threads";
import { Socket } from "node:net";
import { observeDatabaseStream } from "./database-read-cancellation.mjs";
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
  const operationTimeoutMs = dependencies.operationTimeoutMs ?? 8000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 25 ||
    timeoutMs > 2000 ||
    !Number.isInteger(operationTimeoutMs) ||
    operationTimeoutMs < 25 ||
    operationTimeoutMs > 8000
  )
    throw Error("MySQL写入时限无效");
  if (active.size >= 5) throw Error("最多同时执行5个MySQL写入");
  const lease = {};
  active.add(lease);
  const owners = [];
  const deadline = performance.now() + operationTimeoutMs;
  let connection, control, controlOwner, openingController;
  let begun = false,
    dmlAttempted = false,
    dmlActive = false,
    committing = false;
  let phaseTimer,
    killTimer,
    failure,
    cancellation,
    cancellationAttempted = false;
  const closeAll = () => {
    openingController?.abort();
    for (const owner of owners) owner.close();
  };
  const stop = (error) => {
    if (failure) return;
    failure = error;
    clearTimeout(phaseTimer);
    // Only an active DML may need best-effort server cancellation. In particular,
    // never KILL or issue ROLLBACK after COMMIT was attempted. Losing its ACK is
    // an unknown outcome, not evidence that the transaction did not commit.
    const remaining = Math.floor(deadline - performance.now());
    if (dmlActive && !committing && control && remaining > 0) {
      cancellation = (async () => {
        killTimer = setTimeout(
          () => controlOwner.close(),
          Math.min(1000, remaining),
        );
        try {
          cancellationAttempted = true;
          await control.query({ sql: `KILL QUERY ${connection.threadId}` });
        } catch {
          // KILL is best effort; neither its ACK nor transport close is a
          // rollback acknowledgement or proof of remote termination.
        } finally {
          clearTimeout(killTimer);
          controlOwner.close();
        }
      })();
      for (const owner of owners) if (owner !== controlOwner) owner.close();
    } else closeAll();
  };
  const check = () => {
    if (failure) throw failure;
    if (performance.now() >= deadline) {
      stop(Error("MySQL写入操作总时限超时"));
      throw failure;
    }
  };
  const phase = (milliseconds, label) => {
    clearTimeout(phaseTimer);
    check();
    phaseTimer = setTimeout(() => stop(Error(label + "超时")), milliseconds);
  };
  // This is a stricter whole-operation budget, including parser, both connects,
  // setup, prepared metadata/DML, COMMIT/ROLLBACK and best-effort cancellation.
  const totalTimer = setTimeout(() => {
    stop(Error("MySQL写入操作总时限超时"));
    closeAll();
  }, operationTimeoutMs);
  const run = async (label, operation) => {
    phase(timeoutMs, label);
    try {
      const value = await operation();
      check();
      return value;
    } catch {
      // Server errors can contain credentials, SQL literals and bound values.
      // Keep the stage, but never reflect an untrusted driver message to HTTP.
      throw failure || Error(label + "失败，未收到成功确认");
    }
  };
  try {
    const statement = await parseMySQLWrite(input.sql, input.database);
    check();
    const mysql = await import("mysql2/promise");
    check();
    const createConnection =
      dependencies.createConnection || mysql.createConnection;
    const open = async (label) => {
      phase(3000, label);
      openingController = new AbortController();
      try {
        const tunnel = await openDatabaseSSH(input, {
          signal: openingController.signal,
        });
        if (tunnel) owners.push(tunnel);
        check();
        const owner =
          tunnel ||
          observeDatabaseStream(
            dependencies.createStream
              ? dependencies.createStream()
              : new Socket(),
          );
        if (!tunnel) owners.push(owner);
        check();
        const config = remoteConnectionConfig(input);
        if (!tunnel) owner.stream.connect(config.port, config.host);
        const c = await createConnection({
          ...config,
          stream: owner.stream,
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
        check();
        return { connection: c, owner };
      } catch {
        throw failure || Error(label + "失败（包括SSH主机或TLS证书校验）");
      } finally {
        openingController = undefined;
      }
    };
    ({ connection } = await open("MySQL数据连接"));
    check();
    ({ connection: control, owner: controlOwner } =
      await open("MySQL取消连接"));
    check();
    if (
      !Number.isSafeInteger(connection.threadId) ||
      connection.threadId < 1 ||
      connection.threadId > 0xffffffff
    )
      throw Error("无法确认本次MySQL会话标识");
    const command = (sql, label) => run(label, () => connection.query({ sql }));
    await command("SET TRANSACTION READ WRITE", "MySQL写事务初始化");
    check();
    await command("START TRANSACTION", "MySQL事务启动");
    check();
    begun = true;
    // Hold the metadata lock before inspecting the storage engine, unchanged.
    await command(
      `SELECT 1 FROM ${mysql.escapeId(statement.schema, true)}.${mysql.escapeId(statement.table, true)} LIMIT 0 FOR UPDATE`,
      "MySQL目标元数据锁",
    );
    check();
    // One owned deadline covers both PREPARE and EXECUTE. mysql2 command timeout
    // starts too late for PREPARE and can retain timers after stream destruction.
    const [tables] = await run("MySQL元数据校验", () =>
      connection.execute(
        "SELECT ENGINE, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=? LIMIT 2",
        [statement.schema, statement.table],
      ),
    );
    check();
    if (
      tables.length !== 1 ||
      tables[0][0] !== "InnoDB" ||
      tables[0][1] !== "BASE TABLE"
    )
      throw Error("MySQL受限写入仅支持可确认的InnoDB基础表");
    const [result] = await run("MySQL写入", () => {
      dmlAttempted = true;
      dmlActive = true;
      return connection.execute(statement.sql, parameters);
    });
    check();
    dmlActive = false;
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
    check();
    phase(timeoutMs, "MySQL提交");
    committing = true;
    try {
      await connection.query({ sql: "COMMIT" });
    } catch {
      throw failure || Error("MySQL提交失败，未收到成功确认");
    }
    // This final successful command is itself the outcome acknowledgement.
    // Do not turn a genuine ACK into uncertainty because time crossed the
    // deadline before this continuation; no later SQL is queued from here.
    // ACK has been observed. Teardown must not later relabel this as uncertain.
    clearTimeout(phaseTimer);
    clearTimeout(totalTimer);
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
    clearTimeout(phaseTimer);
    if (committing)
      throw Error(
        "提交结果未确认，请先查询数据，不要盲目重试：" + error.message,
      );
    if (failure) {
      throw Error(
        failure.message +
          (dmlAttempted
            ? "，未发出提交，已关闭数据连接" +
              (cancellationAttempted ? "并尝试取消本次查询" : "") +
              "；未收到回滚确认，请核实数据及触发器副作用，不要盲目重试"
            : "，未发送用户写入语句或提交；关闭连接不代表已收到事务回滚确认"),
      );
    }
    if (begun) {
      try {
        dmlActive = false;
        await commandRollback();
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
    // Do not release capacity while a half-open local socket or SSH transport is
    // alive. mysql2.destroy() ends gracefully; it is not transport destruction.
    await cancellation;
    clearTimeout(phaseTimer);
    clearTimeout(totalTimer);
    clearTimeout(killTimer);
    closeAll();
    await Promise.all(owners.map((owner) => owner.closed));
    active.delete(lease);
  }
  async function commandRollback() {
    phase(timeoutMs, "MySQL回滚");
    await connection.query({ sql: "ROLLBACK" });
    // As with COMMIT, an observed final ACK is authoritative during teardown.
    clearTimeout(phaseTimer);
    clearTimeout(totalTimer);
  }
}
