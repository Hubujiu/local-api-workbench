// Only explicit per-call credentials/configuration may reach node-postgres.
// Never modify process.env or pg.defaults: concurrent projects must stay isolated.
export function explicitPostgresOptions(input) {
  const text = (value, label, required = false) => {
    if (
      typeof value !== "string" ||
      !value.isWellFormed() ||
      value.includes("\0") ||
      Buffer.byteLength(value) > 65536 ||
      (required && !value.trim())
    )
      throw Error("PostgreSQL须明确提供有效的" + label);
    return value;
  };
  const user = text(input.user, "user", true),
    database = text(input.database, "database", true);
  const password =
    input.password === undefined ? "" : text(input.password, "password");
  const host =
    input.host === undefined || input.host === ""
      ? "127.0.0.1"
      : text(input.host, "host", true);
  const port =
    input.port === undefined || input.port === 0 || input.port === ""
      ? 5432
      : Number(input.port);
  if (
    (input.port !== undefined &&
      !["string", "number"].includes(typeof input.port)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (typeof input.port === "string" &&
      input.port !== "" &&
      !/^\d+$/.test(input.port))
  )
    throw Error("PostgreSQL端口无效");
  if (input.ssl !== undefined && typeof input.ssl !== "boolean")
    throw Error("PostgreSQL TLS开关必须为布尔值");
  if (input.ca !== undefined) text(input.ca, "CA");
  return {
    host,
    port,
    user,
    database,
    // A provider returning an actual string prevents both PG* fallback and the
    // driver's null-password .pgpass lookup, including repeated auth callbacks.
    password: () => password,
    ssl:
      input.ssl === true
        ? {
            rejectUnauthorized: true,
            verifyIdentity: true,
            ...(input.ca ? { ca: input.ca } : {}),
          }
        : false,
    application_name: "Local API Workbench",
    fallback_application_name: "Local API Workbench",
    client_encoding: "UTF8",
    // Truthy harmless sentinels prevent constructor fallback to PGOPTIONS and
    // PGREPLICATION. They are removed before connect; startup is allowlisted.
    options: " ",
    replication: "false",
    connectionTimeoutMillis: 3000,
    statement_timeout: 2000,
    query_timeout: 3000,
  };
}
export async function createExplicitPostgresClient(
  options,
  { Client, stream, types } = {},
) {
  // This public package subpath bypasses NODE_PG_FORCE_NATIVE/libpq selection.
  const Driver = Client || (await import("pg/lib/client.js")).default;
  const client = new Driver({
    ...options,
    ...(stream ? { stream } : {}),
    ...(types ? { types } : {}),
    binary: false,
  });
  if (client.connectionParameters) {
    client.connectionParameters.options = undefined;
    client.connectionParameters.replication = undefined;
    client.connectionParameters.binary = false;
    client.connectionParameters.client_encoding = "UTF8";
  }
  client.replication = undefined;
  client.binary = false;
  const user = options.user,
    database = options.database;
  client.getStartupConf = () => ({
    user,
    database,
    application_name: "Local API Workbench",
    // pg-protocol appends UTF8 itself; the wire regression verifies it once.
    statement_timeout: "2000",
  });
  return client;
}
