import http from "node:http";
import https from "node:https";

function escapedParameter(value) {
  if (value === null) return "\\N";
  if (
    !["string", "number", "boolean"].includes(typeof value) ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    throw Error("ClickHouse参数须为字符串、有限数字、布尔值或null");
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\0/g, "\\0")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\u0008/g, "\\b")
    .replace(/\f/g, "\\f");
}
export function clickhouseRequest(input) {
  const sql =
    typeof input.sql === "string" ? input.sql.trim().replace(/;\s*$/, "") : "";
  if (!/^(SELECT|WITH)\b/i.test(sql) || sql.length > 50000 || sql.includes(";"))
    throw Error("ClickHouse仅支持单条SELECT/WITH；分号值请使用绑定参数");
  if (/\bSETTINGS\b/i.test(sql))
    throw Error("ClickHouse只读查询不支持自定义SETTINGS，相关文本值请绑定参数");
  const host = input.host || "127.0.0.1";
  if (typeof host !== "string" || /[\s/@?#\\]/.test(host))
    throw Error("ClickHouse主机名无效");
  if (input.ssl !== undefined && typeof input.ssl !== "boolean")
    throw Error("TLS选项无效");
  const port = input.port || (input.ssl ? 8443 : 8123);
  if (
    !Number.isInteger(Number(port)) ||
    Number(port) < 1 ||
    Number(port) > 65535
  )
    throw Error("端口无效");
  const bareHost =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const url = new URL(
    `${input.ssl ? "https" : "http"}://${bareHost.includes(":") ? "[" + bareHost + "]" : bareHost}:${port}/`,
  );
  url.searchParams.set(
    "query",
    `SELECT * FROM (${sql}) AS localapi_result LIMIT 1001 FORMAT JSON`,
  );
  for (const [key, value] of Object.entries({
    max_execution_time: 2,
    max_result_rows: 1001,
    result_overflow_mode: "break",
    enable_http_compression: 0,
  }))
    url.searchParams.set(key, String(value));
  if (input.database) url.searchParams.set("database", String(input.database));
  const parameters = input.parameters ?? [];
  if (!parameters || typeof parameters !== "object")
    throw Error("绑定参数须为数组或命名对象");
  const entries = Array.isArray(parameters)
    ? parameters.map((value, index) => ["p" + index, value])
    : Object.entries(parameters);
  if (entries.length > 1000) throw Error("绑定参数最多1000项");
  for (const [name, value] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z_0-9]{0,99}$/.test(name) ||
      ["__proto__", "constructor", "prototype"].includes(name)
    )
      throw Error("ClickHouse参数名无效");
    url.searchParams.set("param_" + name, escapedParameter(value));
  }
  if (Buffer.byteLength(url.href) > 262144)
    throw Error("ClickHouse请求URL最多256KiB");
  const user = input.user || "default";
  if (
    typeof user !== "string" ||
    user.length > 1000 ||
    user.includes(":") ||
    (input.password !== undefined &&
      (typeof input.password !== "string" || input.password.length > 65536))
  )
    throw Error("ClickHouse用户名无效");
  return {
    url,
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(user + ":" + (input.password || "")).toString("base64"),
      "Accept-Encoding": "identity",
    },
  };
}
export async function queryClickHouse(input) {
  const { url, headers } = clickhouseRequest(input);
  const body = await new Promise((resolve, reject) => {
    const request = (input.ssl ? https : http).request(
      url,
      {
        method: "GET",
        headers,
        rejectUnauthorized: true,
        ...(input.ca && input.ssl ? { ca: input.ca } : {}),
        agent: false,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            request.destroy(Error("ClickHouse响应超过1MiB"));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("aborted", () => reject(Error("ClickHouse响应中断")));
        response.on("end", () => {
          let text;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            );
          } catch {
            reject(Error("ClickHouse响应不是有效UTF-8"));
            return;
          }
          if (
            response.statusCode !== 200 ||
            (response.headers["x-clickhouse-exception-code"] &&
              response.headers["x-clickhouse-exception-code"] !== "0")
          )
            reject(
              Error(
                "ClickHouse查询失败(" +
                  response.statusCode +
                  "): " +
                  text.slice(0, 300),
              ),
            );
          else if (
            response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity"
          )
            reject(Error("不支持压缩的ClickHouse响应"));
          else resolve(text);
        });
      },
    );
    const timer = setTimeout(
      () => request.destroy(Error("ClickHouse请求超过5秒")),
      5000,
    );
    request.once("close", () => clearTimeout(timer));
    request.once("error", reject);
    request.end();
  });
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw Error("ClickHouse未返回有效JSON结果");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray(value.meta) ||
    value.meta.length > 1000 ||
    value.meta.some((column) => !column || typeof column.name !== "string") ||
    !Array.isArray(value.data) ||
    value.data.length > 1001 ||
    value.data.some(
      (row) => !row || typeof row !== "object" || Array.isArray(row),
    )
  )
    throw Error("ClickHouse结果结构无效");
  return {
    columns: value.meta.map((column) => column.name),
    rows: value.data.slice(0, 1000),
    truncated: value.data.length > 1000,
    limit: 1000,
  };
}
