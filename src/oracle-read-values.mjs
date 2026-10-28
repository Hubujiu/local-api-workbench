import { databaseColumns, databaseParameters } from "./database-values.mjs";

const MAX = 1024 * 1024;
const STRING_TYPES = [
  "DB_TYPE_CHAR",
  "DB_TYPE_VARCHAR",
  "DB_TYPE_NCHAR",
  "DB_TYPE_NVARCHAR",
];
const isType = (type, driver, name) =>
  driver?.[name] !== undefined && type === driver[name];
const isStringType = (type, driver) =>
  STRING_TYPES.some((name) => isType(type, driver, name));

function validText(value) {
  return typeof value === "string" && value.isWellFormed();
}

function scalar(value) {
  if (value === null) return;
  if (typeof value === "string") {
    if (!value.isWellFormed() || Buffer.byteLength(value) > MAX)
      throw Error("Oracle WIP bind text is invalid or exceeds 1 MiB");
    return;
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    )
      throw Error("Oracle WIP numeric bind requires a finite, precise value");
    return;
  }
  if (typeof value === "bigint") {
    if (value < -(1n << 63n) || value > (1n << 63n) - 1n)
      throw Error("Oracle WIP integer bind exceeds int64");
    return;
  }
  if (value instanceof Uint8Array && value.byteLength <= MAX) return;
  throw Error("Oracle WIP bind type is unsupported");
}

export function oracleReadParameters(values = []) {
  if (!Array.isArray(values) || values.length > 1000)
    throw Error("Oracle WIP accepts at most 1000 positional binds");
  for (let i = 0; i < values.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, "value"))
      throw Error("Oracle WIP binds must be a dense data array");
    const value = descriptor.value;
    if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw Error("Oracle WIP bind object is unsupported");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (
        Reflect.ownKeys(descriptors).some(
          (key) =>
            typeof key !== "string" ||
            !Object.hasOwn(descriptors[key], "value"),
        )
      )
        throw Error("Oracle WIP bind object must contain only data fields");
      const type = descriptors.type?.value;
      const keys = type === "int64" ? ["type", "value"] : ["type", "base64"];
      if (
        !["int64", "blob"].includes(type) ||
        Reflect.ownKeys(value).some((key) => !keys.includes(key))
      )
        throw Error("Oracle WIP does not accept driver bind descriptors");
      if (
        type === "blob" &&
        (typeof descriptors.base64?.value !== "string" ||
          descriptors.base64.value.length > Math.ceil(MAX / 3) * 4)
      )
        throw Error("Oracle WIP RAW bind exceeds 1 MiB or is invalid");
    } else scalar(value);
  }
  return databaseParameters(values, "oracle").map((value) => {
    scalar(value);
    return value instanceof Uint8Array ? Buffer.from(value) : value;
  });
}

// User objects never reach node-oracledb as bind instructions. Every binding is
// constructed here with an explicit input direction and a narrow scalar type.
export function oracleBindParameters(values, driver) {
  if (
    !driver ||
    ["BIND_IN", "DB_TYPE_VARCHAR", "DB_TYPE_NUMBER", "DB_TYPE_RAW"].some(
      (name) => driver[name] === undefined,
    )
  )
    throw Error("Oracle WIP driver binding constants are unavailable");
  return oracleReadParameters(values).map((value) => ({
    dir: driver.BIND_IN,
    type:
      typeof value === "number" || typeof value === "bigint"
        ? driver.DB_TYPE_NUMBER
        : value instanceof Uint8Array
          ? driver.DB_TYPE_RAW
          : driver.DB_TYPE_VARCHAR,
    val: value,
  }));
}

export function oracleReadFetchType(metadata, driver) {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.isJson === true ||
    metadata.isOson === true
  )
    throw Error("Oracle WIP result type is unsupported");
  if (isType(metadata.dbType, driver, "DB_TYPE_NUMBER"))
    return { type: driver.DB_TYPE_VARCHAR };
  if (
    isStringType(metadata.dbType, driver) ||
    isType(metadata.dbType, driver, "DB_TYPE_RAW")
  )
    return undefined;
  // In particular no eager LOB/LONG fetch, object expansion, JSON parsing,
  // nested cursors, date conversion or driver-private metadata is supported.
  throw Error(
    "Oracle WIP result type is unsupported; select a supported scalar",
  );
}

// Name-only validation for fetchTypeHandler's raw rowset metadata. Later
// columns may not yet have public normalized dbType properties in driver 26.
export function oracleReadColumnNames(metadata) {
  if (!Array.isArray(metadata) || !metadata.length || metadata.length > 128)
    throw Error("Oracle WIP result requires 1 to 128 scalar columns");
  for (let i = 0; i < metadata.length; i++)
    if (!Object.hasOwn(metadata, i))
      throw Error("Oracle WIP result metadata must be a complete column array");
  return databaseColumns(
    metadata.map((column) => {
      if (
        !column ||
        typeof column !== "object" ||
        Array.isArray(column) ||
        !validText(column.name) ||
        !column.name.length ||
        column.name.includes("\0") ||
        Buffer.byteLength(column.name) > 512
      )
        throw Error(
          "Oracle WIP result column name is invalid or exceeds limits",
        );
      return column.name;
    }),
  );
}

export function oracleReadColumns(metadata, driver) {
  const columns = oracleReadColumnNames(metadata);
  for (const column of metadata) {
    oracleReadFetchType(column, driver);
    if (
      column.byteSize !== undefined &&
      (!Number.isInteger(column.byteSize) ||
        column.byteSize < 0 ||
        column.byteSize > MAX)
    )
      throw Error(
        "Oracle WIP result column metadata is invalid or exceeds limits",
      );
  }
  return columns;
}

export function oracleReadRow(row, metadata, driver) {
  const columns = oracleReadColumns(metadata, driver);
  if (!Array.isArray(row) || row.length !== columns.length)
    throw Error("Oracle WIP result must contain a complete scalar row array");
  const entries = columns.map((name, i) => {
    const value = row[i];
    const type = metadata[i].dbType;
    if (value === null) return [name, null];
    if (isType(type, driver, "DB_TYPE_NUMBER")) {
      if (
        !validText(value) ||
        value.length > 512 ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
      )
        throw Error("Oracle WIP NUMBER result must be an exact numeric string");
      return [name, value];
    }
    if (isStringType(type, driver)) {
      if (!validText(value) || Buffer.byteLength(value) > MAX)
        throw Error("Oracle WIP string result is invalid or exceeds 1 MiB");
      return [name, value];
    }
    if (!(value instanceof Uint8Array) || value.byteLength > MAX)
      throw Error("Oracle WIP RAW result is invalid or exceeds 1 MiB");
    return [
      name,
      { type: "blob", base64: Buffer.from(value).toString("base64") },
    ];
  });
  const result = Object.fromEntries(entries);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX)
    throw Error("Oracle WIP result row exceeds 1 MiB");
  return result;
}
