import {
  checkDatabaseSignal,
  databaseCancelled,
} from "./database-read-cancellation.mjs";
import net from "node:net";
import tls from "node:tls";
const MAX_REPLY = 2 * 1024 * 1024,
  MAX_BULK = 1024 * 1024;
export function encodeRESP(args) {
  const buffers = [Buffer.from("*" + args.length + "\r\n")];
  for (const value of args) {
    const b = Buffer.from(String(value));
    buffers.push(Buffer.from("$" + b.length + "\r\n"), b, Buffer.from("\r\n"));
  }
  const result = Buffer.concat(buffers);
  if (result.length > 65536) throw Error("Redis请求超过64KiB");
  return result;
}
export function parseRESP(buffer) {
  if (buffer.length > MAX_REPLY) throw Error("Redis响应超过2MiB");
  let nodes = 0;
  function parse(offset, depth) {
    if (depth > 8 || ++nodes > 5000) throw Error("Redis响应结构超过上限");
    if (offset >= buffer.length) return null;
    const end = buffer.indexOf("\r\n", offset);
    if (end < 0) {
      if (buffer.length - offset > 65536) throw Error("RESP头过长");
      return null;
    }
    const type = String.fromCharCode(buffer[offset]),
      text = buffer.subarray(offset + 1, end).toString("utf8"),
      start = end + 2;
    if (type === "+") return { value: text, bytes: start };
    if (type === "-") throw Error("Redis: " + text.slice(0, 2000));
    if (
      ![":", "$", "*"].includes(type) ||
      !/^[+-]?\d+$/.test(text) ||
      text.length > 24
    )
      throw Error("RESP类型或长度无效");
    if (type === ":") {
      const value = BigInt(text);
      return {
        value:
          value <= BigInt(Number.MAX_SAFE_INTEGER) &&
          value >= BigInt(Number.MIN_SAFE_INTEGER)
            ? Number(value)
            : String(value),
        bytes: start,
      };
    }
    const length = Number(text);
    if (length === -1) return { value: null, bytes: start };
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > (type === "$" ? MAX_BULK : 2002)
    )
      throw Error("Redis声明响应大小超过上限");
    if (type === "$") {
      if (buffer.length < start + length + 2) return null;
      if (buffer[start + length] !== 13 || buffer[start + length + 1] !== 10)
        throw Error("RESP数据结束标记无效");
      return {
        value: Buffer.from(buffer.subarray(start, start + length)),
        bytes: start + length + 2,
      };
    }
    let cursor = start;
    const values = [];
    for (let i = 0; i < length; i++) {
      const next = parse(cursor, depth + 1);
      if (!next) return null;
      values.push(next.value);
      cursor = next.bytes;
    }
    return { value: values, bytes: cursor };
  }
  return parse(0, 0);
}
function commandArguments(input, stringsOnly = false) {
  let args = input.command;
  if (args === undefined) {
    try {
      args = JSON.parse(input.sql);
    } catch {
      throw Error('Redis命令须为JSON数组，例如["GET","key"]');
    }
  }
  if (
    !Array.isArray(args) ||
    !args.length ||
    args.length > 102 ||
    Array.from({ length: args.length }, (_, i) => i).some(
      (i) =>
        !Object.hasOwn(args, i) ||
        !(stringsOnly ? ["string"] : ["string", "number"]).includes(
          typeof args[i],
        ) ||
        (stringsOnly && !args[i].isWellFormed()) ||
        Buffer.byteLength(String(args[i])) > 4096,
    )
  )
    throw Error("Redis命令参数无效");
  args = args.map(String);
  args[0] = args[0].toUpperCase();
  return args;
}
export function redisCommand(input) {
  let args = commandArguments(input);
  const [command, ...rest] = args;
  const exact = {
    PING: 0,
    GET: 1,
    TYPE: 1,
    TTL: 1,
    PTTL: 1,
    STRLEN: 1,
    HLEN: 1,
    LLEN: 1,
    SCARD: 1,
    ZCARD: 1,
    HGET: 2,
    HEXISTS: 2,
    SISMEMBER: 2,
    ZSCORE: 2,
  };
  if (Object.hasOwn(exact, command)) {
    if (rest.length !== exact[command]) throw Error("Redis命令参数数量无效");
  } else if (["MGET", "EXISTS"].includes(command)) {
    if (rest.length < 1 || rest.length > 100) throw Error("Redis最多100个key");
  } else if (command === "HMGET") {
    if (rest.length < 2 || rest.length > 101)
      throw Error("Redis HMGET参数无效");
  } else if (["LRANGE", "ZRANGE", "GETRANGE"].includes(command)) {
    if (rest.length !== 3 || !rest.slice(1).every((s) => /^-?\d+$/.test(s)))
      throw Error("Redis范围参数无效");
    const from = Number(rest[1]),
      to = Number(rest[2]);
    if (
      ![from, to].every(Number.isSafeInteger) ||
      from > to ||
      (from >= 0 && to < 0) ||
      to - from + 1 > (command === "GETRANGE" ? 65536 : 1000)
    )
      throw Error("Redis范围必须显式限制大小");
  } else if (["SCAN", "HSCAN", "SSCAN", "ZSCAN"].includes(command)) {
    const base = command === "SCAN" ? 1 : 2;
    if (rest.length < base || !/^\d+$/.test(rest[base - 1]))
      throw Error("Redis SCAN游标无效");
    const used = new Set();
    for (let i = base; i < rest.length; i += 2) {
      const key = rest[i].toUpperCase(),
        value = rest[i + 1];
      if (
        !["MATCH", "COUNT"].includes(key) ||
        value === undefined ||
        used.has(key)
      )
        throw Error("Redis SCAN选项无效");
      used.add(key);
      rest[i] = key;
      if (
        key === "COUNT" &&
        (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000)
      )
        throw Error("Redis SCAN COUNT须为1至1000");
    }
    args = [command, ...rest];
  } else
    throw Error(
      "Redis仅支持有界只读命令；写入、脚本、管理和无界集合读取被禁止",
    );
  encodeRESP(args);
  return args;
}
export function redisWriteCommand(input) {
  if (input.allowWrite !== true) throw Error("Redis写入需要仅本次明确授权");
  const args = commandArguments(input, true);
  if (args[0] !== "SET" || args.length < 3 || !args[1])
    throw Error("Redis写入仅支持单键SET，键名不能为空，参数须为字符串");
  let condition = false,
    expiry = false;
  for (let i = 3; i < args.length; i++) {
    const option = args[i].toUpperCase();
    args[i] = option;
    if (["NX", "XX"].includes(option) && !condition) condition = true;
    else if (["EX", "PX", "KEEPTTL"].includes(option) && !expiry) {
      expiry = true;
      if (option !== "KEEPTTL") {
        const ttl = args[++i];
        if (
          !/^[1-9]\d*$/.test(ttl || "") ||
          !Number.isSafeInteger(Number(ttl)) ||
          Number(ttl) > 2147483647
        )
          throw Error("Redis EX/PX时长须为1至2147483647的整数字符串");
      }
    } else throw Error("Redis SET选项不支持或重复；仅支持NX/XX与EX/PX/KEEPTTL");
  }
  encodeRESP(args);
  return args;
}
export async function mutateRedis(input) {
  const command = redisWriteCommand(input);
  if (
    input.type !== "redis" ||
    typeof input.host !== "string" ||
    !input.host ||
    input.host.trim() !== input.host ||
    !["string", "number"].includes(typeof input.port) ||
    !Number.isInteger(Number(input.port)) ||
    Number(input.port) < 1 ||
    Number(input.port) > 65535 ||
    !["string", "number"].includes(typeof input.database) ||
    !/^(0|[1-9]\d*)$/.test(String(input.database)) ||
    Number(input.database) > 1023
  )
    throw Error("Redis写入必须明确指定主机、端口和数据库索引0至1023");
  return executeRedis(input, command, true);
}
function output(value) {
  if (Buffer.isBuffer(value)) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      return { encoding: "base64", data: value.toString("base64") };
    }
  }
  return Array.isArray(value) ? value.map(output) : value;
}
function table(command, value) {
  let cursor;
  if (["SCAN", "HSCAN", "SSCAN", "ZSCAN"].includes(command)) {
    if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[1]))
      throw Error("Redis SCAN响应格式无效");
    cursor = output(value[0]);
    value = value[1];
  }
  let rows, columns;
  if (["HSCAN", "ZSCAN"].includes(command)) {
    if (value.length % 2) throw Error("Redis键值响应不完整");
    columns = ["key", "value"];
    rows = [];
    for (let i = 0; i < value.length; i += 2)
      rows.push({ key: output(value[i]), value: output(value[i + 1]) });
  } else if (Array.isArray(value)) {
    columns = ["index", "value"];
    rows = value.map((item, index) => ({ index, value: output(item) }));
  } else {
    columns = ["value"];
    rows = [{ value: output(value) }];
  }
  return {
    columns,
    rows: rows.slice(0, 1000),
    truncated: rows.length > 1000,
    limit: 1000,
    ...(cursor === undefined ? {} : { cursor }),
  };
}
export async function queryRedis(input, { signal } = {}) {
  checkDatabaseSignal(signal);
  return executeRedis(input, redisCommand(input), false, signal);
}
async function executeRedis(input, command, writing, signal) {
  checkDatabaseSignal(signal);
  const host = input.host || "127.0.0.1",
    port = Number(input.port) || 6379,
    database = Number(input.database || 0);
  if (
    typeof host !== "string" ||
    host.length > 253 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isInteger(database) ||
    database < 0 ||
    database > 1023
  )
    throw Error("Redis连接地址/数据库索引无效");
  for (const key of ["user", "password"])
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" || Buffer.byteLength(input[key]) > 8192)
    )
      throw Error("Redis认证参数无效");
  if (
    input.ca !== undefined &&
    (typeof input.ca !== "string" || Buffer.byteLength(input.ca) > 65536)
  )
    throw Error("Redis CA无效");
  const commands = [];
  if (input.user || input.password)
    commands.push(
      input.user
        ? ["AUTH", input.user, input.password || ""]
        : ["AUTH", input.password],
    );
  if (database) commands.push(["SELECT", String(database)]);
  commands.push(command);
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0),
      received = 0,
      index = 0,
      settled = false,
      writeSent = false;
    if (input.ssl !== undefined && typeof input.ssl !== "boolean")
      throw Error("Redis TLS开关无效");
    const options = { host, port },
      socket = input.ssl
        ? tls.connect({
            ...options,
            servername: net.isIP(host) ? undefined : host,
            rejectUnauthorized: true,
            ...(input.ca ? { ca: input.ca } : {}),
          })
        : net.connect(options);
    const closed = new Promise((resolve) => socket.once("close", resolve));
    const cancel = () => finish(databaseCancelled());
    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      socket.destroy();
      if (!writing) await closed;
      if (signal?.aborted) error = databaseCancelled();
      if (error && writeSent) {
        error = Error(
          error.message +
            "；Redis写入结果可能不确定，不能盲目重试，请先核查目标键（不能回滚）",
        );
        error.code = "REDIS_WRITE_UNCERTAIN";
      }
      error ? reject(error) : resolve(result);
    };
    const timeout = Math.min(
      3000,
      Math.max(100, Number(input.timeoutMs) || 3000),
    );
    const timer = setTimeout(
      () => finish(Error("Redis查询超时（总时限已到），已断开")),
      timeout,
    );
    const send = () => {
      if (settled) return;
      checkDatabaseSignal(signal);
      const packet = encodeRESP(commands[index]);
      if (writing && index === commands.length - 1) writeSent = true;
      socket.write(packet);
    };
    socket.once(input.ssl ? "secureConnect" : "connect", () => {
      try {
        send();
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(Error("Redis连接提前关闭")));
    socket.on("data", (chunk) => {
      if (settled) return;
      try {
        checkDatabaseSignal(signal);
        received += chunk.length;
        if (received > MAX_REPLY) throw Error("Redis响应超过2MiB");
        buffer = Buffer.concat([buffer, chunk]);
        const frame = parseRESP(buffer);
        if (!frame) return;
        if (frame.bytes !== buffer.length)
          throw Error("Redis收到额外的未请求响应");
        const nullBulk = buffer.equals(Buffer.from("$-1\r\n"));
        buffer = Buffer.alloc(0);
        if (index === commands.length - 1) {
          const result = table(command[0], frame.value);
          if (writing) {
            const conditional = command
              .slice(3)
              .some((option) => ["NX", "XX"].includes(option));
            if (
              frame.value !== "OK" &&
              !(conditional && frame.value === null && nullBulk)
            )
              throw Error("Redis SET确认响应无效");
            return finish(null, {
              write: true,
              command: "SET",
              acknowledged: true,
              applied: frame.value === "OK",
              affectedKeys: frame.value === "OK" ? 1 : 0,
              ...result,
              limit: 1,
            });
          }
          return finish(null, result);
        }
        if (frame.value !== "OK") throw Error("Redis认证或数据库选择失败");
        index++;
        send();
      } catch (error) {
        finish(error);
      }
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
