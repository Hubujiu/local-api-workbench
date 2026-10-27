import { openDatabaseSSH } from "./database-ssh.mjs";
import { databaseParameters } from "./database-values.mjs";
import {
  explicitPostgresOptions,
  createExplicitPostgresClient,
} from "./postgres-client.mjs";

// Conservative subset, not a complete PostgreSQL parser. Parameter binding is
// required for dollar-quoted/backslash-escaped data. Balance is essential: the
// caller's SQL must not escape the server-side counting CTE.
export function validatePostgresWrite(sql) {
  if (
    typeof sql !== "string" ||
    sql.length > 50000 ||
    !/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)
  )
    throw Error("PostgreSQL 写入仅支持单条 INSERT / UPDATE / DELETE");
  if (sql.includes("\\")) throw Error("SQL 不支持反斜杠转义，请使用绑定参数");
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      let closed = false;
      for (i++; i < sql.length; i++) {
        if (sql[i] !== c) continue;
        if (sql[i + 1] === c) {
          i++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) throw Error("SQL 引号未闭合");
    } else if (
      (c === "-" && sql[i + 1] === "-") ||
      (c === "/" && sql[i + 1] === "*")
    ) {
      throw Error("写入 SQL 暂不支持注释");
    } else if (c === "$") {
      const parameter = /^\$[1-9]\d*\b/.exec(sql.slice(i));
      if (!parameter) throw Error("写入 SQL 暂不支持美元引号，请使用绑定参数");
      i += parameter[0].length - 1;
    } else if (c === "(") {
      if (++depth > 32) throw Error("SQL 嵌套超过32层");
    } else if (c === ")") {
      if (--depth < 0) throw Error("SQL 括号不匹配");
    } else if (c === ";") {
      if (sql.slice(i + 1).trim()) throw Error("仅允许单条写入语句");
      sql = sql.slice(0, i);
      break;
    } else if (/[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(sql.slice(i))[0];
      if (word.toUpperCase() === "RETURNING")
        throw Error("PostgreSQL 写入暂不支持 RETURNING；仅返回影响行数");
      i += word.length - 1;
    }
  }
  if (depth !== 0) throw Error("SQL 括号不匹配");
  return sql.trim();
}

/** Manual, per-call opt-in only. Session/script/CLI database paths stay read-only. */
export async function mutatePostgres(input, dependencies = {}) {
  if (input.type !== "postgres" || input.allowWrite !== true)
    throw Error("PostgreSQL 写入需要本次明确授权");
  for (const field of ["host", "user", "database"])
    if (typeof input[field] !== "string" || !input[field].trim())
      throw Error("请明确填写 PostgreSQL 主机、数据库和用户");
  const sql = validatePostgresWrite(input.sql),
    parameters = input.parameters === undefined ? [] : input.parameters;
  if (
    !Array.isArray(parameters) ||
    parameters.length > 1000 ||
    Buffer.byteLength(JSON.stringify(parameters)) > 1024 * 1024
  )
    throw Error("绑定参数必须是数组，最多1000项、1MiB");
  const boundParameters = databaseParameters(parameters, "postgres");
  const options = explicitPostgresOptions(input);
  const tunnel = await openDatabaseSSH(input);
  try {
    const client = await createExplicitPostgresClient(options, {
      Client: dependencies.Client,
      stream: tunnel?.stream,
    });
    client.on?.("error", () => {}); // Active operations report connection errors through their promises.
    let begun = false,
      committing = false;
    try {
      await client.connect();
      await client.query("BEGIN READ WRITE");
      begun = true;
      // PostgreSQL counts RETURNING rows on the server; arbitrary row payloads
      // cannot accumulate in node-postgres memory. Extended mode forbids batches.
      const result = await client.query({
        text: `WITH localapi_written AS (${sql} RETURNING 1) SELECT count(*)::text AS affected_rows FROM localapi_written`,
        values: boundParameters,
        queryMode: "extended",
      });
      const count = result.rows?.[0]?.affected_rows;
      if (
        result.rows?.length !== 1 ||
        typeof count !== "string" ||
        !/^\d+$/.test(count) ||
        !Number.isSafeInteger(Number(count))
      )
        throw Error("无法验证写入影响行数");
      const affectedRows = Number(count);
      if (affectedRows > 1000) throw Error("写入目标行数超过1000行");
      committing = true;
      await client.query("COMMIT");
      begun = false;
      return {
        columns: [],
        rows: [],
        affectedRows,
        committed: true,
        truncated: false,
        limit: 1000,
      };
    } catch (error) {
      if (committing)
        throw Error(
          "提交结果未确认，请先查询数据，不要盲目重试：" + error.message,
        );
      if (begun) {
        try {
          await client.query("ROLLBACK");
        } catch {
          throw Error(
            "写入失败且未收到回滚确认，连接将关闭；请先核实数据和触发器副作用，不要盲目重试",
          );
        }
        throw Error(
          "写入事务已回滚（不包含序列与外部副作用）：" + error.message,
        );
      }
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  } finally {
    tunnel?.close();
  }
}
