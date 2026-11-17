// Internal preparation only; no public provider.
import { types } from "node:util";
const fail = (message) => {
  throw Error(`SQL Server contract: ${message}`);
};
function object(value, keys) {
  if (
    !value ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail("plain data object required");
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !Object.hasOwn(d, "value")
    )
      fail("unknown field or accessor");
    result[key] = d.value;
  }
  return result;
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
export function sqlServerConnectionContract(input) {
  input = object(input, [
    "host",
    "port",
    "user",
    "password",
    "database",
    "ca",
    "ssl",
  ]);
  for (const key of ["host", "user", "database"])
    if (!text(input[key], key).trim()) fail(`explicit ${key} required`);
  const password = text(input.password, "password"); // Never ambient fallback.
  if (input.ssl !== true) fail("verified TLS must be explicitly enabled");
  const port = input.port === undefined ? 1433 : input.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("invalid port");
  if (input.ca !== undefined && !text(input.ca, "ca").trim())
    fail("invalid CA");
  return {
    server: input.host,
    authentication: {
      type: "default",
      options: { userName: input.user, password },
    },
    options: {
      database: input.database,
      port,
      encrypt: true,
      trustServerCertificate: false,
      maxRetriesOnTransientErrors: 0,
      connectTimeout: 3000,
      requestTimeout: 2000,
      rowCollectionOnRequestCompletion: false,
      rowCollectionOnDone: false,
      ...(input.ca === undefined
        ? {}
        : {
            cryptoCredentialsDetails: {
              ca: input.ca,
              rejectUnauthorized: true,
            },
          }),
    },
  };
}
export function sqlServerResultTypeAllowed(type) {
  // Decimal/Money and all temporal types require a future proven exact text
  // projection. Never silently accept Number rounding or Date truncation.
  if (
    ![
      "Bit",
      "TinyInt",
      "SmallInt",
      "Int",
      "BigInt",
      "Char",
      "VarChar",
      "NChar",
      "NVarChar",
      "Binary",
      "VarBinary",
    ].includes(type)
  )
    fail("result type requires a verified lossless projection");
  return true;
}

export function snapshotSQLServerInput(input) {
  return object(input, ["connection", "sql", "parameters"]);
}
