import { isIP } from "node:net";
import { oracleReadParameters } from "./oracle-read-values.mjs";
import { oracleReadCACertificate } from "./oracle-read-ca.mjs";

const FIELDS = new Set([
  "host",
  "port",
  "service",
  "user",
  "password",
  "ssl",
  "sql",
  "parameters",
  "caCertificatePem",
]);

function text(value, label, maxBytes) {
  if (
    typeof value !== "string" ||
    !value.length ||
    !value.isWellFormed() ||
    value.includes("\0") ||
    Buffer.byteLength(value) > maxBytes
  )
    throw Error("Oracle WIP requires an explicit valid " + label);
  return value;
}

// A deliberately narrow, disabled connection contract. It never accepts a raw
// descriptor, TNS alias, configuration URL, wallet path, or driver options bag.
export function oracleReadInput(input) {
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw Error("Oracle WIP connection input must be a plain object");
  for (const key of Reflect.ownKeys(input)) {
    if (
      !FIELDS.has(key) ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), "value")
    )
      throw Error("Oracle WIP connection field is unsupported");
  }
  for (const key of [
    "host",
    "port",
    "service",
    "user",
    "password",
    "ssl",
    "sql",
  ])
    if (!Object.hasOwn(input, key))
      throw Error("Oracle WIP requires explicit connection fields and SQL");

  const host = text(input.host, "host", 253);
  if (host.includes("%"))
    throw Error("Oracle WIP does not support scoped IP literals");
  const ipVersion = isIP(host);
  if (
    !ipVersion &&
    !host
      .split(".")
      .every((part) =>
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part),
      )
  )
    throw Error("Oracle WIP host must be an atomic DNS name or IP address");
  const port = input.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("Oracle WIP port must be an explicit integer from 1 to 65535");
  const service = text(input.service, "service", 255);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_$.-]*$/.test(service))
    throw Error("Oracle WIP service must be a single service-name token");
  const user = text(input.user, "user", 128);
  if (!/^[A-Za-z][A-Za-z0-9_$#]*$/.test(user) || /^(SYS|SYSTEM)$/i.test(user))
    throw Error("Oracle WIP requires an ordinary non-proxy read-only user");
  const password = text(input.password, "password", 65536);
  if (input.ssl !== true) throw Error("Oracle WIP supports explicit TCPS only");
  const sql = text(input.sql, "SQL", 200000);
  if (!sql.trim() || sql.length > 50000)
    throw Error("Oracle WIP SQL must contain at most 50000 characters");

  const connectionOptions = {
    connectString: `tcps://${ipVersion === 6 ? `[${host}]` : host}:${port}/${service}`,
    user,
    password,
    externalAuth: false,
    // Connection-attempt retries only, not internal query-message re-execution.
    retryCount: 0,
    connectTimeout: 3,
    transportConnectTimeout: 3,
    sslServerDNMatch: true,
    sslAllowWeakDNMatch: false,
  };
  const caCertificatePem = Object.hasOwn(input, "caCertificatePem")
    ? oracleReadCACertificate(input.caCertificatePem)
    : oracleReadCACertificate();
  if (
    Buffer.byteLength(JSON.stringify({ connectionOptions, caCertificatePem })) >
    128 * 1024
  )
    throw Error("Oracle WIP connection configuration exceeds 128 KiB");
  return {
    connectionOptions,
    caCertificatePem,
    sql,
    binds: oracleReadParameters(
      input.parameters === undefined ? [] : input.parameters,
    ),
  };
}
