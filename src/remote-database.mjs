import { queryClickHouse } from "./clickhouse.mjs";
import { queryMongo } from "./mongodb.mjs";
import { queryRedis } from "./redis.mjs";
/** Read-only DB connections; credentials are request-scoped and never persisted here. */
export async function queryRemoteDatabase(input, dependencies = {}) {
  if (input.type === "clickhouse") return queryClickHouse(input);
  if (input.type === "redis") return queryRedis(input);
  if (input.type === "mongodb") return queryMongo(input);
  const { type, sql, parameters = [] } = input;
  if (!["postgres", "mysql"].includes(type)) throw Error("数据库类型无效");
  if (
    typeof sql !== "string" ||
    sql.length > 50000 ||
    !/^\s*(SELECT\b|WITH\b)/i.test(sql)
  )
    throw Error("远程数据库仅接受 SELECT / WITH 查询");
  if (!Array.isArray(parameters)) throw Error("参数必须是数组");
  const boundedSQL = `SELECT * FROM (${sql.trim().replace(/;\s*$/, "")}) AS localapi_result LIMIT 1001`;
  const config = remoteConnectionConfig(input);
  let rows, columns;
  if (type === "postgres") {
    const { Client } = dependencies.Client ? dependencies : await import("pg");
    const client = new Client({
      ...config,
      connectionTimeoutMillis: 3000,
      statement_timeout: 2000,
      query_timeout: 3000,
    });
    try {
      await client.connect();
      await client.query("BEGIN READ ONLY");
      const result = await client.query({
        text: boundedSQL,
        values: parameters,
        queryMode: "extended",
      });
      rows = result.rows;
      columns = result.fields.map((field) => field.name);
    } finally {
      await client.end();
    }
  } else {
    const mysql = await import("mysql2/promise");
    const connection = await mysql.createConnection({
      ...config,
      connectTimeout: 3000,
      multipleStatements: false,
    });
    try {
      await connection.query("SET TRANSACTION READ ONLY");
      await connection.query("START TRANSACTION");
      const [result, fields] = await connection.query(
        { sql: boundedSQL, timeout: 2000 },
        parameters,
      );
      rows = result;
      columns = fields.map((field) => field.name);
    } finally {
      connection.destroy();
    }
  }
  return {
    columns,
    rows: rows.slice(0, 1000),
    truncated: rows.length > 1000,
    limit: 1000,
  };
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
            ...(input.ca ? { ca: input.ca } : {}),
          },
        }
      : {}),
  };
}
