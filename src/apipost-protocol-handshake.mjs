import {
  normalizeHandshake,
  persistentHandshakeHeaders,
  protocolHeaders,
} from "./protocol-handshake.mjs";
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
export function nativeProtocolHandshake(request, sourceCopy, type) {
  const headers = {},
    required = new Set();
  const rowsFor = (kind) => {
    const config = request[kind];
    if (config === undefined) return [];
    if (
      !object(config) ||
      Object.keys(config).some(
        (k) =>
          ![
            "parameter",
            ...(kind === "cookie" ? ["cookie_encode"] : []),
          ].includes(k),
      )
    )
      throw Error("原版协议握手配置无效");
    const rows = config.parameter ?? [];
    if (!Array.isArray(rows) || rows.length > 50)
      throw Error("原版协议握手行超限");
    for (const row of rows) {
      if (
        !object(row) ||
        Object.keys(row).some(
          (k) =>
            ![
              "param_id",
              "key",
              "value",
              "is_checked",
              "description",
              "type",
              "field_type",
              "schema",
              "not_null",
            ].includes(k),
        )
      )
        throw Error("原版协议握手行字段无效");
      if (row.field_type !== undefined && row.field_type !== "string")
        throw Error("原版协议握手字段类型尚未支持");
      if (
        row.schema !== undefined &&
        (!object(row.schema) ||
          Object.keys(row.schema).some((k) => k !== "type") ||
          row.schema.type !== "string")
      )
        throw Error("原版协议握手Schema尚未支持");
      if (
        typeof (row.key ?? "") !== "string" ||
        typeof (row.value ?? "") !== "string" ||
        Buffer.byteLength(row.key ?? "") > 1024 ||
        Buffer.byteLength(row.value ?? "") > 8192
      )
        throw Error("原版协议握手行须为有界文本");
      if (
        row.is_checked !== undefined &&
        (!Number.isInteger(row.is_checked) ||
          ![-1, 0, 1].includes(row.is_checked))
      )
        throw Error("原版协议握手启用标志无效");
    }
    return rows;
  };
  const names = new Set();
  const headerRows = rowsFor("header");
  for (const row of sourceCopy.request?.header?.parameter || [])
    if (!persistentHandshakeHeaders.has((row.key ?? "").trim().toLowerCase()))
      delete row.value;
  for (const row of headerRows) {
    const key = (row.key ?? "").trim().toLowerCase();
    if (!key) continue;
    const active = row.is_checked > 0;
    const safe = persistentHandshakeHeaders.has(key);
    if (!safe)
      for (const copy of sourceCopy.request?.header?.parameter || [])
        if ((copy.key ?? "").trim().toLowerCase() === key) delete copy.value;
    if (!active) continue;
    if (names.has(key)) throw Error("原版协议Header名称冲突");
    names.add(key);
    protocolHeaders({ [key]: row.value ?? "" });
    if ((row.value ?? "").includes("{{") || key.includes("{{"))
      throw Error("原版协议握手模板尚未支持");
    if (safe) headers[key] = row.value ?? "";
    else required.add(key);
  }
  const cookies = rowsFor("cookie");
  for (const row of sourceCopy.request?.cookie?.parameter || [])
    delete row.value;
  const activeCookies = cookies.filter(
    (row) => row.is_checked > 0 && (row.key ?? "").trim(),
  );
  if (activeCookies.length) {
    if (names.has("cookie"))
      throw Error("Cookie Header与Cookie行同时配置尚未支持");
    const cookieNames = new Set();
    for (const row of activeCookies) {
      const key = row.key.trim();
      if (
        cookieNames.has(key) ||
        /[;=\s]/.test(key) ||
        (row.value ?? "").includes("{{") ||
        key.includes("{{")
      )
        throw Error("原版协议Cookie冲突或模板无效");
      cookieNames.add(key);
    }
    required.add("cookie");
  }
  const auth = request.auth;
  if (auth && !["inherit", "noauth"].includes(auth.type)) {
    if (type !== "sse" || !["basic", "bearer", "kv"].includes(auth.type))
      throw Error("原版协议认证尚未支持");
    const provider = auth[auth.type];
    if (!object(provider)) throw Error("原版协议认证配置无效");
    const fields = {
      basic: ["username", "password"],
      bearer: ["key"],
      kv: ["key", "value", "in"],
    }[auth.type];
    if (
      Object.keys(provider).some((k) => !fields.includes(k)) ||
      Object.values(provider).some(
        (v) =>
          typeof v !== "string" ||
          v.includes("{{") ||
          Buffer.byteLength(v) > 8192,
      )
    )
      throw Error("原版协议认证字段无效");
    if (auth.type === "kv" && provider.in !== "header")
      throw Error("原版协议API Key仅支持Header");
    const key =
      auth.type === "kv" ? provider.key?.trim().toLowerCase() : "authorization";
    protocolHeaders({ [key]: "placeholder" });
    if (
      !key ||
      names.has(key) ||
      Object.hasOwn(headers, key) ||
      required.has(key)
    )
      throw Error("原版协议认证与Header冲突");
    required.add(key);
  }
  if (sourceCopy.request?.auth)
    sourceCopy.request.auth = { type: sourceCopy.request.auth.type };
  if (!Object.keys(headers).length && !required.size) return undefined;
  return normalizeHandshake({ headers, requiredHeaders: [...required] }, type);
}
