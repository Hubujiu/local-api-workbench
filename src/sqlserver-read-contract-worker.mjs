import { parentPort, workerData } from "node:worker_threads";
// Inert SQL Server WIP contract. No network driver and no provider registration.
import transactSQL from "node-sql-parser/build/transactsql.js";
const parser = new transactSQL.Parser();
const fail = (message) => {
  throw Error(`SQL Server WIP: ${message}`);
};
function object(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype)
    fail("plain object required");
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !Object.hasOwn(d, "value")
    )
      fail("unknown field or accessor");
  }
  return value;
}
function text(value, label, max = 65536) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.includes("\0") ||
    Buffer.byteLength(value) > max
  )
    fail(`invalid ${label}`);
  return value;
}
const id = (value) => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z_][A-Za-z_0-9]{0,127}$/.test(value)
  )
    fail("only bounded ASCII identifiers supported");
  return `[${value}]`;
};
function column(node) {
  object(node, ["type", "table", "db", "schema", "column", "collate"]);
  if (
    node.type !== "column_ref" ||
    node.table != null ||
    node.db != null ||
    node.schema != null ||
    node.collate != null
  )
    fail("only unqualified columns supported");
  return id(node.column);
}
function compileSQLServerRead(sql, parameters) {
  text(sql, "SQL", 50000);
  // This first subset deliberately rejects quoted names, literals, comments,
  // brackets and expressions; parser success never authorizes arbitrary T-SQL.
  if (!/^[A-Za-z_0-9@.,=<>!;\s]+$/.test(sql))
    fail("unsupported SQL characters");
  let ast;
  try {
    ast = parser.astify(sql);
  } catch {
    fail("invalid SELECT syntax");
  }
  if (Array.isArray(ast)) {
    if (ast.length !== 1) fail("one SELECT only");
    ast = ast[0];
  }
  object(ast, [
    "with",
    "type",
    "options",
    "distinct",
    "columns",
    "into",
    "from",
    "for",
    "where",
    "groupby",
    "having",
    "top",
    "orderby",
    "limit",
  ]);
  if (ast.type !== "select") fail("SELECT only");
  for (const key of [
    "with",
    "options",
    "distinct",
    "for",
    "groupby",
    "having",
    "top",
    "limit",
  ])
    if (ast[key] != null) fail(`unsupported ${key}`);
  object(ast.into, ["position"]);
  if (ast.into.position != null) fail("INTO forbidden");
  if (!Array.isArray(ast.from) || ast.from.length !== 1)
    fail("one local table required");
  const table = object(ast.from[0], [
    "db",
    "table",
    "as",
    "table_hint",
    "temporal_table",
    "operator",
  ]);
  for (const key of ["as", "table_hint", "temporal_table", "operator"])
    if (table[key] != null) fail("table modifiers forbidden");
  const from = `${id(table.db)}.${id(table.table)}`;
  if (
    !Array.isArray(ast.columns) ||
    !ast.columns.length ||
    ast.columns.length > 128
  )
    fail("explicit bounded columns required");
  const names = [],
    columns = ast.columns.map((c) => {
      object(c, ["expr", "as"]);
      const expression = column(c.expr);
      const name = c.as ?? c.expr.column;
      id(name);
      names.push(name.toLowerCase());
      return expression + (c.as == null ? "" : ` AS ${id(c.as)}`);
    });
  if (new Set(names).size !== names.length) fail("duplicate output names");
  const used = new Set();
  let nodes = 0;
  const where = (n) => {
    if (++nodes > 64) fail("predicate limit");
    object(n, ["type", "operator", "left", "right"]);
    if (n.type !== "binary_expr") fail("comparison required");
    if (n.operator === "AND") return `(${where(n.left)} AND ${where(n.right)})`;
    if (!["=", "!=", "<>", "<", ">", "<=", ">="].includes(n.operator))
      fail("unsupported comparator");
    const lhs = column(n.left),
      r = n.right;
    object(r, ["type", "table", "db", "schema", "column", "collate"]);
    if (
      r.type !== "column_ref" ||
      r.table != null ||
      r.db != null ||
      r.schema != null ||
      r.collate != null ||
      !/^@p(0|[1-9]\d*)$/.test(r.column)
    )
      fail("comparison requires @pN");
    const i = Number(r.column.slice(2));
    if (i >= parameters.length) fail("missing parameter");
    used.add(i);
    return `${lhs} ${n.operator} @p${i}`;
  };
  const predicate = ast.where == null ? "" : ` WHERE ${where(ast.where)}`;
  if (used.size !== parameters.length) fail("unused parameters");
  let order = "";
  if (ast.orderby != null) {
    if (!Array.isArray(ast.orderby) || ast.orderby.length > 16)
      fail("order limit");
    order =
      " ORDER BY " +
      ast.orderby
        .map((o) => {
          object(o, ["expr", "type"]);
          if (![null, "ASC", "DESC"].includes(o.type)) fail("order direction");
          return column(o.expr) + " " + (o.type || "ASC");
        })
        .join(", ");
  }
  return {
    sql: `SELECT TOP (1001) ${columns.join(", ")} FROM ${from}${predicate}${order}`,
    parameters,
    requiredDatabaseUpdateability: "READ_ONLY",
    schema: table.db,
    table: table.table,
    limit: 1000,
    maxBytes: 1024 * 1024,
  };
}

try {
  parentPort.postMessage({
    result: compileSQLServerRead(workerData.sql, workerData.parameters),
  });
} catch {
  parentPort.postMessage({
    error: "SQL Server contract: unsupported or invalid query",
  });
}
