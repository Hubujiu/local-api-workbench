import { Socket } from "node:net";
import {
  databaseCancelled,
  checkDatabaseSignal,
  observeDatabaseStream,
} from "./database-read-cancellation.mjs";
import {
  explicitPostgresOptions,
  createExplicitPostgresClient,
} from "./postgres-client.mjs";
import { openDatabaseSSH } from "./database-ssh.mjs";
import { postgresValueTypes } from "./postgres-values.mjs";
import {
  databaseParameters,
  databaseRows,
  databaseQueryError,
} from "./database-values.mjs";
import { queryClickHouse } from "./clickhouse.mjs";
import { queryMongo } from "./mongodb.mjs";
import { queryRedis } from "./redis.mjs";
/** Read-only DB connections; credentials are request-scoped and never persisted here. */
export async function queryRemoteDatabase(input, dependencies = {}) {
  const signal = dependencies.signal;
  checkDatabaseSignal(signal);
  if (input.ssh !== undefined && !["postgres", "mysql"].includes(input.type))
    throw Error("SSH 通道目前仅支持 PostgreSQL/MySQL，不会退回直连");
  if (input.type === "clickhouse") return queryClickHouse(input, { signal });
  if (input.type === "redis") return queryRedis(input, { signal });
  if (input.type === "mongodb") return queryMongo(input, { signal });
  const { type, sql } = input;
  const parameters = databaseParameters(
    input.parameters === undefined ? [] : input.parameters,
    type,
  );
  if (!["postgres", "mysql"].includes(type)) throw Error("数据库类型无效");
  if (
    typeof sql !== "string" ||
    sql.length > 50000 ||
    !/^\s*(SELECT\b|WITH\b)/i.test(sql)
  )
    throw Error("远程数据库仅接受 SELECT / WITH 查询");
  if (!Array.isArray(parameters)) throw Error("参数必须是数组");
  const boundedSQL = `SELECT * FROM (${sql.trim().replace(/;\s*$/, "")}) AS localapi_result LIMIT 1001`;
  const config =
    type === "postgres"
      ? explicitPostgresOptions(input)
      : remoteConnectionConfig(input);
  const controller = new AbortController();
  let owner, tunnel, phaseTimer, failure, result;
  const stop = (error) => {
    failure ??= error;
    controller.abort();
    owner?.close();
  };
  const cancel = () => stop(databaseCancelled());
  const check = () => {
    if (failure) throw failure;
    checkDatabaseSignal(signal);
  };
  const phase = (milliseconds, label) => {
    clearTimeout(phaseTimer);
    check();
    phaseTimer = setTimeout(
      () => stop(Error(label + "超时，连接已关闭；不会重放请求")),
      milliseconds,
    );
  };
  const totalTimer = setTimeout(
    () => stop(Error("数据库只读操作超过8秒，连接已关闭；不会重放请求")),
    8000,
  );
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    check();
    tunnel = await openDatabaseSSH(input, { signal: controller.signal });
    check();
    owner = tunnel || observeDatabaseStream(new Socket());
    config.stream = owner.stream;
    let rows, columns;
    if (type === "postgres") {
      phase(3000, "PostgreSQL连接");
      const client = await createExplicitPostgresClient(config, {
        Client: dependencies.Client,
        types: postgresValueTypes,
      });
      client.on?.("error", () => {});
      // A destroyed Socket can be reconnected: never call connect after abort.
      check();
      await client.connect();
      check();
      phase(2000, "PostgreSQL只读事务初始化");
      await client.query("BEGIN READ ONLY");
      check();
      phase(2000, "PostgreSQL只读查询");
      const value = await client.query({
        rowMode: "array",
        text: boundedSQL,
        values: parameters,
        queryMode: "extended",
      });
      check();
      rows = value.rows;
      columns = value.fields.map((field) => field.name);
    } else {
      const mysql = (await import("mysql2")).default;
      check();
      phase(3000, "MySQL连接");
      if (!tunnel) owner.stream.connect(config.port, config.host);
      const driver = mysql.createConnection({
        ...config,
        connectTimeout: 3000,
        multipleStatements: false,
        supportBigNumbers: true,
        bigNumberStrings: true,
        decimalNumbers: false,
        dateStrings: true,
        rowsAsArray: true,
      });
      driver.on("error", () => {});
      const connection = driver.promise();
      await connection.connect();
      check();
      phase(2000, "MySQL只读事务初始化");
      await connection.query("SET TRANSACTION READ ONLY");
      check();
      phase(2000, "MySQL事务初始化");
      await connection.query("START TRANSACTION");
      check();
      // One owned deadline includes PREPARE. mysql2's per-command timeout
      // otherwise survives forced closure and can keep a cancelled process alive.
      phase(2000, "MySQL只读查询");
      const [value, fields] = await connection.execute(
        { sql: boundedSQL },
        parameters,
      );
      check();
      rows = value;
      columns = fields.map((field) => field.name);
    }
    result = databaseRows(columns, rows);
  } catch (error) {
    failure ??= databaseQueryError(error);
  } finally {
    clearTimeout(phaseTimer);
    clearTimeout(totalTimer);
    // Do not use mysql.destroy() (graceful end / suppressed pending errors),
    // nor wait on pg.end() after forced closure. The caller owns this stream.
    owner?.close();
    if (tunnel) tunnel.close();
    await (owner?.closed || tunnel?.closed);
    signal?.removeEventListener("abort", cancel);
  }
  check();
  return result;
}

export function remoteConnectionConfig(input) {
  return {
    host: input.host || "127.0.0.1",
    port: Number(input.port) || (input.type === "postgres" ? 5432 : 3306),
    user: input.user,
    password: input.password,
    database: input.database,
    ...(input.ssl
      ? {
          ssl: {
            rejectUnauthorized: true,
            verifyIdentity: true,
            ...(input.ca ? { ca: input.ca } : {}),
          },
        }
      : {}),
  };
}
