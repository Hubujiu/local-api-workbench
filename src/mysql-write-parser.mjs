import { parentPort, workerData } from "node:worker_threads";
import mysqlParser from "node-sql-parser/build/mysql.js";
try {
  const parsed = new mysqlParser.Parser().astify(workerData.sql);
  const ast = Array.isArray(parsed)
    ? parsed.length === 1
      ? parsed[0]
      : null
    : parsed;
  if (
    !ast ||
    !["insert", "update", "delete"].includes(ast.type) ||
    ast.with ||
    ast.on_duplicate_update ||
    ast.returning ||
    ast.ignore
  )
    throw Error(
      "MySQL写入仅支持单表INSERT/UPDATE/DELETE，不支持批次或特殊修改器",
    );
  if (
    ast.type === "insert" &&
    (ast.prefix !== "into" ||
      ast.values?.type !== "values" ||
      !Array.isArray(ast.values.values) ||
      ast.values.values.length > 1000)
  )
    throw Error(
      "MySQL INSERT仅支持最多1000行VALUES，不支持SELECT/IGNORE/重复键更新",
    );
  const tables = ast.table;
  if (
    !Array.isArray(tables) ||
    tables.length !== 1 ||
    tables[0].as ||
    tables[0].join ||
    typeof tables[0].table !== "string"
  )
    throw Error("MySQL写入仅支持不带别名的单一目标表");
  const target = tables[0];
  if (
    ast.type === "delete" &&
    (!Array.isArray(ast.from) ||
      ast.from.length !== 1 ||
      ast.from[0].table !== target.table ||
      ast.from[0].as ||
      ast.from[0].join)
  )
    throw Error("MySQL DELETE仅支持单一目标表");
  const schema = target.db || workerData.database;
  if (
    schema !== workerData.database ||
    !target.table ||
    target.table.length > 64 ||
    target.table.includes("\0")
  )
    throw Error("MySQL写入目标必须位于明确指定的数据库");
  const stack = [{ node: ast, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (++nodes > 10000 || depth > 32) throw Error("MySQL SQL结构超限");
    if (
      node !== ast &&
      ["select", "insert", "update", "delete", "replace"].includes(node.type)
    )
      throw Error("MySQL写入不支持子查询或嵌套语句");
    for (const value of Object.values(node))
      if (value && typeof value === "object")
        stack.push({ node: value, depth: depth + 1 });
  }
  parentPort.postMessage({
    ok: true,
    value: {
      sql: workerData.sql.trim().replace(/;\s*$/, ""),
      table: target.table,
      schema,
      type: ast.type,
    },
  });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error.message.startsWith("MySQL")
      ? error.message
      : "MySQL写入SQL语法无效或超出支持范围",
  });
}
parentPort.close();
