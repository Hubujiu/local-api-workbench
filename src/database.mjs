import { DatabaseSync } from "node:sqlite";
export function querySQLite(filename, sql, parameters = []) {
  if (typeof filename !== "string" || !filename.trim())
    throw Error("数据库路径为空");
  if (typeof sql !== "string" || sql.length > 50000) throw Error("SQL 无效");
  if (!/^\s*(SELECT\b|WITH\b|EXPLAIN\b)/i.test(sql))
    throw Error("仅支持只读 SELECT / WITH / EXPLAIN 查询");
  const db = new DatabaseSync(filename, {
    readOnly: true,
    allowExtension: false,
  });
  try {
    const statement = db.prepare(sql);
    const columns = statement.columns().map((c) => c.name),
      rows = [];
    let truncated = false;
    for (const row of statement.iterate(...parameters)) {
      if (rows.length >= 1000) {
        truncated = true;
        break;
      }
      rows.push(
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            k,
            typeof v === "bigint" ? String(v) : v,
          ]),
        ),
      );
    }
    return { columns, rows, truncated, limit: 1000 };
  } finally {
    db.close();
  }
}
export async function querySQLiteBounded(filename, sql, parameters = []) {
  const { Worker } = await import("node:worker_threads");
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./database-worker.mjs", import.meta.url),
      {
        workerData: { filename, sql, parameters },
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      },
    );
    const timer = setTimeout(() => {
      worker.terminate();
      reject(Error("数据库查询超过 2 秒，已终止"));
    }, 2000);
    worker.once("message", (message) => {
      clearTimeout(timer);
      worker.terminate();
      message.error ? reject(Error(message.error)) : resolve(message.result);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(Error("数据库查询进程已退出"));
    });
  });
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
    let info,
      bytes = 0;
    if (columns.length) {
      for (const row of statement.iterate(...parameters)) {
        if (rows.length >= 1000) throw Error("写入返回结果超过1000行，已回滚");
        const converted = Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            typeof value === "bigint"
              ? String(value)
              : value instanceof Uint8Array
                ? {
                    type: "blob",
                    base64: Buffer.from(value).toString("base64"),
                  }
                : value,
          ]),
        );
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
  const { Worker } = await import("node:worker_threads");
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./database-worker.mjs", import.meta.url),
      {
        workerData: { filename, sql, parameters, mode: "write" },
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      },
    );
    let message, workerError;
    const timer = setTimeout(() => worker.terminate(), 2000);
    worker.once("message", (value) => {
      message = value;
      clearTimeout(timer);
    });
    worker.once("error", (error) => {
      workerError = error;
    });
    worker.once("exit", () => {
      clearTimeout(timer);
      if (message?.error) reject(Error(message.error));
      else if (message?.result) resolve(message.result);
      else
        reject(
          Error(
            "数据库写入结果未确认，请先查询数据，不要直接重试" +
              (workerError ? ": " + workerError.message : ""),
          ),
        );
    });
  });
}
