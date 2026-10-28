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
    output_format_json_quote_64bit_integers: 1,
    output_format_json_quote_decimals: 1,
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
// Decimal JSON numbers cannot be recovered after JSON.parse. Require quoted
// values and validate only the Decimal leaves of explicitly supported wrappers.
// Complex Decimal types fail closed, including empty results (no sample inference).
function decimalValidator(type, depth = 0) {
  if (
    typeof type !== "string" ||
    type.length === 0 ||
    type.length > 4096 ||
    depth > 16
  )
    throw Error("ClickHouse列类型无效或嵌套过深");
  type = type.trim();
  // These types can hide the actual Decimal leaf type from FORMAT JSON meta.
  if (/\b(?:Dynamic|JSON|Object)\b/.test(type))
    throw Error("ClickHouse动态类型无法证明Decimal精度；请投影为显式类型");
  const wrapper = /^(Nullable|Array|LowCardinality)\s*\(([\s\S]*)\)$/.exec(
    type,
  );
  if (wrapper) {
    const validate = decimalValidator(wrapper[2], depth + 1);
    if (!validate) return null;
    return (value) => {
      if (wrapper[1] === "Nullable" && value === null) return;
      if (wrapper[1] === "Array") {
        if (!Array.isArray(value))
          throw Error("ClickHouse Decimal数组结构无效");
        for (const item of value) validate(item);
      } else validate(value);
    };
  }
  const decimal = /^Decimal\(\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)$/.exec(type);
  const sized = /^Decimal(32|64|128|256)\(\s*(\d{1,2})\s*\)$/.exec(type);
  if (!decimal && !sized) {
    if (/\bDecimal(?:32|64|128|256)?\b/.test(type))
      throw Error(
        "ClickHouse不支持此Decimal类型包装；请显式投影为Decimal、Nullable或Array",
      );
    return null;
  }
  const precision = decimal
    ? Number(decimal[1])
    : { 32: 9, 64: 18, 128: 38, 256: 76 }[sized[1]];
  const scale = Number(decimal ? decimal[2] : sized[2]);
  if (precision < 1 || precision > 76 || scale > precision)
    throw Error("ClickHouse Decimal精度或小数位无效");
  return (value) => {
    if (
      typeof value !== "string" ||
      value.length > 79 ||
      !/^-?\d+(?:\.\d+)?$/.test(value)
    )
      throw Error(
        "ClickHouse Decimal必须以十进制字符串返回，禁止不精确JSON数字",
      );
    const [integer, fraction = ""] = value.replace(/^-/, "").split(".");
    if (
      integer.replace(/^0+/, "").length > precision - scale ||
      fraction.length > scale
    )
      throw Error("ClickHouse Decimal值超出声明精度或小数位");
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
    value = JSON.parse(body, (key, item) => {
      if (
        typeof item === "number" &&
        Number.isInteger(item) &&
        !Number.isSafeInteger(item)
      )
        throw Error("整数超出JavaScript安全整数范围，服务器必须以字符串返回");
      return item;
    });
  } catch (error) {
    throw Error(
      "ClickHouse未返回安全JSON结果：" + String(error.message).slice(0, 160),
    );
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
  const names = new Set();
  const validators = value.meta.map((column) => {
    if (names.has(column.name))
      throw Error("ClickHouse列名重复，无法校验Decimal类型");
    names.add(column.name);
    return [column.name, decimalValidator(column.type)];
  });
  for (const row of value.data) {
    for (const [name, validate] of validators) {
      if (validate) {
        if (!Object.hasOwn(row, name)) throw Error("ClickHouse Decimal列缺失");
        validate(row[name]);
      }
    }
  }
  return {
    columns: value.meta.map((column) => column.name),
    rows: value.data.slice(0, 1000),
    truncated: value.data.length > 1000,
    limit: 1000,
  };
}
