// Internal compiler plans only, never accept catalog metadata from a request.
// Catalog and data are read on the same owned, verified READ_ONLY connection.
const fail = () => {
  throw Error("SQL Server exact output rejected");
};
const id = (v) => {
  if (typeof v !== "string" || !/^[A-Za-z_][A-Za-z_0-9]{0,127}$/.test(v))
    fail();
  return `[${v}]`;
};
const catalogNames = [
  "name",
  "type",
  "precision",
  "scale",
  "computed",
  "encrypted",
];
export function exactCatalogPlan(plan) {
  const names = [...new Set(plan.projection.map((p) => p.column))];
  if (!names.length || names.length > 128) fail();
  [plan.schema, plan.table, ...names].forEach(id);
  const parameters = [plan.schema, plan.table, ...names].map((value, i) => ({
    name: `p${i}`,
    type: "NVarChar",
    value,
  }));
  return {
    sql:
      "SELECT TOP (129) c.name AS [name], ty.name AS [type], CONVERT(int,c.precision) AS [precision], CONVERT(int,c.scale) AS [scale], CONVERT(int,c.is_computed) AS [computed], CONVERT(int,CASE WHEN c.encryption_type IS NULL THEN 0 ELSE 1 END) AS [encrypted] FROM sys.columns AS c INNER JOIN sys.tables AS t ON t.object_id=c.object_id INNER JOIN sys.schemas AS s ON s.schema_id=t.schema_id INNER JOIN sys.types AS ty ON ty.user_type_id=c.user_type_id AND ty.user_type_id=ty.system_type_id WHERE s.name=@p0 AND t.name=@p1 AND c.name IN (" +
      names.map((_, i) => `@p${i + 2}`).join(",") +
      ")",
    parameters,
  };
}
export function exactProjectionPlan(plan, metadata) {
  if (
    JSON.stringify(metadata.columns) !== JSON.stringify(catalogNames) ||
    metadata.rows.length > 128
  )
    fail();
  const catalog = new Map();
  for (const row of metadata.rows) {
    id(row.name);
    if (
      catalog.has(row.name) ||
      row.computed !== 0 ||
      row.encrypted !== 0 ||
      !Number.isInteger(row.precision) ||
      !Number.isInteger(row.scale)
    )
      fail();
    catalog.set(row.name, row);
  }
  // Exact case matching is intentional even on case-insensitive servers.
  const wanted = new Set(plan.projection.map((p) => p.column));
  if (
    catalog.size !== wanted.size ||
    [...catalog.keys()].some((k) => !wanted.has(k))
  )
    fail();
  const columns = plan.projection.map((p) => {
    const m = catalog.get(p.column);
    if (!m) fail();
    const expression = id(p.column);
    let sql;
    if (["decimal", "numeric"].includes(m.type)) {
      if (
        m.precision < 1 ||
        m.precision > 38 ||
        m.scale < 0 ||
        m.scale > m.precision
      )
        fail();
      sql = `CONVERT(varchar(41), ${expression})`;
    } else if (
      ["date", "time", "datetime2", "datetimeoffset"].includes(m.type)
    ) {
      if (m.scale < 0 || m.scale > 7 || (m.type === "date" && m.scale !== 0))
        fail();
      const [length, style] = {
        date: [10, 23],
        time: [16, 126],
        datetime2: [27, 126],
        datetimeoffset: [34, 127],
      }[m.type];
      sql = `CONVERT(varchar(${length}), ${expression}, ${style})`;
    } else if (
      [
        "bigint",
        "int",
        "smallint",
        "tinyint",
        "bit",
        "char",
        "varchar",
        "nchar",
        "nvarchar",
        "binary",
        "varbinary",
      ].includes(m.type)
    ) {
      sql = expression;
    } else fail(); // money, floats, legacy datetime, CLR/alias/LOB remain closed.
    return {
      name: p.name,
      type: m.type,
      precision: m.precision,
      scale: m.scale,
      sql: sql + ` AS ${id(p.name)}`,
    };
  });
  return {
    sql: `SELECT TOP (1001) ${columns.map((c) => c.sql).join(", ")}${plan.tail}`,
    columns,
  };
}
export function validateExactResult(result, columns) {
  if (
    JSON.stringify(result.columns) !==
    JSON.stringify(columns.map((c) => c.name))
  )
    fail();
  for (const row of result.rows)
    for (const c of columns) {
      const value = row[c.name];
      if (value === null) continue;
      if (["decimal", "numeric"].includes(c.type)) {
        if (
          typeof value !== "string" ||
          value.length > 41 ||
          !/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)
        )
          fail();
        const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
        if (
          fraction.length !== c.scale ||
          (whole === "0" ? 0 : whole.length) > c.precision - c.scale
        )
          fail();
      } else if (
        ["date", "time", "datetime2", "datetimeoffset"].includes(c.type)
      ) {
        const date = "\\d{4}-\\d{2}-\\d{2}",
          time =
            "\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1," + Math.max(c.scale, 1) + "})?";
        const pattern = {
          date,
          time,
          datetime2: date + "T" + time,
          datetimeoffset: date + "T" + time + "(?:Z|[+-]\\d{2}:\\d{2})",
        }[c.type];
        if (
          typeof value !== "string" ||
          value.length > 34 ||
          !new RegExp("^" + pattern + "$").test(value) ||
          (c.scale === 0 && value.includes("."))
        )
          fail();
      }
    }
}
