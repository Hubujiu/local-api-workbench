import {
  databaseColumns,
  databaseParameters,
  databaseRow,
} from "./database-values.mjs";
import { DatabaseSync } from "node:sqlite";
export function querySQLite(filename, sql, parameters = []) {
  if (typeof filename !== "string" || !filename.trim())
    throw Error("数据库路径为空");
  if (typeof sql !== "string" || sql.length > 50000) throw Error("SQL 无效");
  if (!/^\s*(SELECT\b|WITH\b|EXPLAIN\b)/i.test(sql))
    throw Error("仅支持只读 SELECT / WITH / EXPLAIN 查询");
  parameters = databaseParameters(parameters, "sqlite");
  const db = new DatabaseSync(filename, {
    readOnly: true,
    allowExtension: false,
  });
  try {
    const statement = db.prepare(sql);
    statement.setReadBigInts(true);
    const columns = statement.columns().map((c) => c.name),
      rows = [];
    databaseColumns(columns);
    let bytes = Buffer.byteLength(JSON.stringify(columns)) + 100;
    let truncated = false;
    for (const row of statement.iterate(...parameters)) {
      if (rows.length >= 1000) {
        truncated = true;
        break;
      }
      const value = databaseRow(row, columns);
      bytes += Buffer.byteLength(JSON.stringify(value)) + 1;
      if (bytes > 1024 * 1024) throw Error("数据库结果超过1MiB");
      rows.push(value);
    }
    return { columns, rows, truncated, limit: 1000 };
  } finally {
    db.close();
  }
}
export async function querySQLiteBounded(filename, sql, parameters = []) {
  const { runSQLiteProcess } = await import("./database-process.mjs");
  return runSQLiteProcess({ filename, sql, parameters, mode: "read" });
}

// Opt-in DML path; existing query functions remain read-only.
export function mutateSQLite(filename, sql, parameters = []) {
  if (
    typeof sql !== "string" ||
    sql.length > 50000 ||
    !/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)
  )
    throw Error("写入仅支持单条 INSERT / UPDATE / DELETE（不支持REPLACE）");
  if (!Array.isArray(parameters)) throw Error("绑定参数必须是数组");
  parameters = databaseParameters(parameters, "sqlite");
  const words = [];
  let quote = "",
    comment = "",
    ended = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i],
      n = sql[i + 1];
    if (comment === "line") {
      if (c === "\n") comment = "";
      continue;
    }
    if (comment === "block") {
      if (c === "*" && n === "/") {
        comment = "";
        i++;
      }
      continue;
    }
    if (quote) {
      if (c === quote) {
        if (n === quote && quote !== "]") {
          i++;
          continue;
        }
        quote = "";
      }
      continue;
    }
    if (c === "-" && n === "-") {
      comment = "line";
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      comment = "block";
      i++;
      continue;
    }
    if (ended) {
      if (!/\s/.test(c)) throw Error("仅支持单条写入语句");
      continue;
    }
    if (["'", '"', "`", "["].includes(c)) {
      quote = c === "[" ? "]" : c;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let word = c;
      while (/[A-Za-z_0-9]/.test(sql[i + 1] || "")) word += sql[++i];
      words.push(word.toUpperCase());
    }
    if (c === ";") ended = true;
  }
  if (words.some((word, i) => word === "OR" && words[i + 1] === "REPLACE"))
    throw Error("REPLACE可能产生未计数删除，写入模式不支持");
  if (quote || comment === "block") throw Error("SQL字符串或注释未闭合");
  if (typeof filename !== "string" || !filename.trim())
    throw Error("数据库路径为空");
  // Do not create a new file merely because an opt-in operation fails.
  const probe = new DatabaseSync(filename, {
    readOnly: true,
    allowExtension: false,
  });
  probe.close();
  const db = new DatabaseSync(filename, {
    readOnly: false,
    allowExtension: false,
  });
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    const statement = db.prepare(sql),
      columns = statement.columns().map((c) => c.name),
      rows = [];
    statement.setReadBigInts(true);
    databaseColumns(columns);
    let info,
      bytes = 0;
    if (columns.length) {
      for (const row of statement.iterate(...parameters)) {
        if (rows.length >= 1000) throw Error("写入返回结果超过1000行，已回滚");
        const converted = databaseRow(row, columns);
        bytes += Buffer.byteLength(JSON.stringify(converted));
        if (bytes > 1024 * 1024) throw Error("写入结果超过1MiB，已回滚");
        rows.push(converted);
      }
    } else info = statement.run(...parameters);
    const changed = db.prepare("SELECT total_changes() AS count").get().count;
    if (changed > 1000) throw Error("写入及触发器修改超过1000行，已回滚");
    const affectedRows =
      info?.changes ?? db.prepare("SELECT changes() AS count").get().count;
    db.exec("COMMIT");
    committed = true;
    return {
      columns,
      rows,
      affectedRows: Number(affectedRows),
      totalChanges: Number(changed),
      committed: true,
      limit: 1000,
    };
  } finally {
    if (!committed) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
    db.close();
  }
}
export async function mutateSQLiteBounded(filename, sql, parameters = []) {
  const { runSQLiteProcess } = await import("./database-process.mjs");
  return runSQLiteProcess({ filename, sql, parameters, mode: "write" });
}
