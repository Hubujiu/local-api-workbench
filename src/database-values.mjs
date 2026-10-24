const MAX = 1024 * 1024;
export function databaseColumns(columns) {
  if (
    !Array.isArray(columns) ||
    columns.some((x) => typeof x !== "string") ||
    new Set(columns).size !== columns.length
  )
    throw Error("数据库结果包含重复列名，请使用唯一别名");
  return columns;
}
export function databaseValue(value, depth = 0) {
  if (depth > 32) throw Error("数据库结果嵌套过深");
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "bigint")
    return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw Error("数据库结果包含非有限数值，请显式转换为文本");
    return value;
  }
  if (value instanceof Uint8Array)
    return { type: "blob", base64: Buffer.from(value).toString("base64") };
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw Error("数据库日期无效");
    return value.toISOString();
  }
  if (Array.isArray(value))
    return value.map((x) => databaseValue(x, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, databaseValue(v, depth + 1)]),
    );
  throw Error("数据库结果包含不可序列化值");
}
export function databaseRow(row, columns) {
  return Object.fromEntries(
    columns.map((name, index) => [
      name,
      databaseValue(Array.isArray(row) ? row[index] : row[name]),
    ]),
  );
}
export function databaseRows(columns, rows, limit = 1000) {
  databaseColumns(columns);
  const result = [];
  let bytes = Buffer.byteLength(JSON.stringify(columns)) + 100;
  for (const row of rows.slice(0, limit)) {
    const value = databaseRow(row, columns);
    bytes += Buffer.byteLength(JSON.stringify(value)) + 1;
    if (bytes > MAX) throw Error("数据库结果超过1MiB");
    result.push(value);
  }
  return { columns, rows: result, truncated: rows.length > limit, limit };
}
export function parseDatabaseJSON(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX)
    throw Error("数据库JSON结果超过1MiB");
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        throw Error("数据库JSON数值超出范围，请转换为文本");
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        if (typeof context?.source !== "string")
          throw Error("运行时不支持精确JSON数值读取");
        return context.source;
      }
    }
    return value;
  });
}
export function databaseParameters(values = [], provider) {
  if (!Array.isArray(values) || values.length > 1000)
    throw Error("数据库绑定参数最多1000项");
  let bytes = 0;
  return values.map((value) => {
    let result = value;
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Uint8Array)
    ) {
      if (value.type === "int64") {
        if (
          Object.keys(value).some((k) => !["type", "value"].includes(k)) ||
          typeof value.value !== "string" ||
          !/^(-?(0|[1-9]\d*))$/.test(value.value) ||
          value.value.length > 20
        )
          throw Error("int64绑定值格式无效");
        result = BigInt(value.value);
        if (result < -(1n << 63n) || result > (1n << 63n) - 1n)
          throw Error("int64绑定值超出范围");
      } else if (value.type === "blob") {
        if (
          Object.keys(value).some((k) => !["type", "base64"].includes(k)) ||
          typeof value.base64 !== "string"
        )
          throw Error("二进制绑定格式无效");
        result = Buffer.from(value.base64, "base64");
        if (result.toString("base64") !== value.base64)
          throw Error("二进制绑定编码无效");
      } else if (provider === "sqlite")
        throw Error("SQLite对象参数须为int64/blob类型，请将JSON显式编码为文本");
    }
    if (
      typeof result === "number" &&
      (!Number.isFinite(result) ||
        (Number.isInteger(result) && !Number.isSafeInteger(result)))
    )
      throw Error("大整数参数请使用int64类型或精确字符串");
    if (typeof result === "string" && !result.isWellFormed())
      throw Error("绑定参数Unicode无效");
    if (
      result === undefined ||
      typeof result === "function" ||
      typeof result === "symbol"
    )
      throw Error("绑定参数类型无效");
    if (provider === "sqlite" && typeof result === "boolean")
      result = Number(result);
    bytes +=
      typeof result === "bigint"
        ? result.toString().length
        : result instanceof Uint8Array
          ? result.byteLength
          : Buffer.byteLength(JSON.stringify(result));
    if (bytes > MAX) throw Error("数据库绑定参数超过1MiB");
    return result;
  });
}

export function databaseQueryError(error) {
  if (error?.code === "ER_DUP_FIELDNAME") {
    const failure = new Error("数据库结果包含重复列名，请使用唯一别名", {
      cause: error,
    });
    failure.code = error.code;
    return failure;
  }
  return error;
}
