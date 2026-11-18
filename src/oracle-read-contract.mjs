import { types } from "node:util";
const fail = () => {
  throw Error("ORACLE_READ_INPUT_INVALID");
};
function plain(value, keys) {
  if (
    !value ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail();
  const out = {};
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !Object.hasOwn(d, "value")
    )
      fail();
    out[key] = d.value;
  }
  return out;
}
function text(value, max = 65536) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.includes("\0") ||
    Buffer.byteLength(value) > max
  )
    fail();
  return value;
}
export function compileOracleRead(input) {
  input = plain(input, ["connection", "sql", "parameters"]);
  const c = plain(input.connection, [
    "host",
    "port",
    "user",
    "password",
    "database",
    "ssl",
    "serverDN",
  ]);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(text(c.host, 253)) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(text(c.database, 128)) ||
    c.ssl !== true
  )
    fail();
  for (const key of ["user", "serverDN"]) if (!text(c[key]).trim()) fail();
  text(c.password);
  const port = c.port === undefined ? 2484 : c.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail();
  const values = input.parameters ?? [];
  if (
    types.isProxy(values) ||
    !Array.isArray(values) ||
    Object.getPrototypeOf(values) !== Array.prototype ||
    values.length > 64 ||
    Reflect.ownKeys(values).length !== values.length + 1
  )
    fail();
  const binds = {};
  for (let i = 0; i < values.length; i++) {
    const d = Object.getOwnPropertyDescriptor(values, String(i));
    if (!d || !Object.hasOwn(d, "value")) fail();
    const v = d.value;
    if (typeof v === "string") text(v, 32767);
    else if (v !== null && !Number.isSafeInteger(v)) fail();
    binds[`p${i}`] = v;
  }
  if (Buffer.byteLength(JSON.stringify(binds)) > 131072) fail();
  const sql = text(input.sql, 8192).trim();
  const identifier = "[A-Za-z_][A-Za-z0-9_]{0,29}";
  const m = new RegExp(
    `^SELECT (${identifier}(?: AS ${identifier})?(?:,\\s*${identifier}(?: AS ${identifier})?)*) FROM (${identifier})\\.(${identifier})(?: WHERE (.+?))?(?: ORDER BY (.+?))?;?$`,
    "i",
  ).exec(sql);
  if (!m) fail();
  const quote = (name) => `"${name.toUpperCase()}"`;
  const columns = m[1].split(/,\s*/).map((c) => c.split(/ AS /i));
  if (
    columns.length > 128 ||
    new Set(columns.map((c) => (c[1] ?? c[0]).toUpperCase())).size !==
      columns.length
  )
    fail();
  const used = new Set();
  let where = "";
  if (m[4]) {
    const parts = m[4].split(/ AND /i);
    if (parts.length > 64) fail();
    where =
      " WHERE " +
      parts
        .map((part) => {
          const p = new RegExp(
            `^(${identifier})\\s*(=|<>|!=|<=|>=|<|>)\\s*:p(0|[1-9][0-9]*)$`,
          ).exec(part);
          if (!p || Number(p[3]) >= values.length) fail();
          used.add(Number(p[3]));
          return `${quote(p[1])} ${p[2]} :p${p[3]}`;
        })
        .join(" AND ");
  }
  if (used.size !== values.length) fail();
  let order = "";
  if (m[5]) {
    const parts = m[5].split(/,\s*/);
    if (parts.length > 16) fail();
    order =
      " ORDER BY " +
      parts
        .map((part) => {
          const o = new RegExp(`^(${identifier})(?: (ASC|DESC))?$`, "i").exec(
            part,
          );
          if (!o) fail();
          return `${quote(o[1])} ${(o[2] ?? "ASC").toUpperCase()}`;
        })
        .join(", ");
  }
  return {
    relation: `${m[2].toUpperCase()}.${m[3].toUpperCase()}`,
    config: {
      user: c.user,
      password: c.password,
      connectString: `tcps://${c.host}:${port}/${c.database}?retry_count=0&connect_timeout=3&transport_connect_timeout=3`,
      sslServerDNMatch: true,
      sslServerCertDN: c.serverDN,
      sslAllowWeakDNMatch: false,
      externalAuth: false,
      stmtCacheSize: 0,
      configDir: "",
    },
    sql: `SELECT ${columns.map((c) => quote(c[0]) + (c[1] ? ` AS ${quote(c[1])}` : "")).join(", ")} FROM ${quote(m[2])}.${quote(m[3])}${where}${order} FETCH FIRST 1001 ROWS ONLY`,
    binds,
  };
}
