import {
  checkDatabaseSignal,
  databaseCancelled,
  observeDatabaseStream,
} from "./database-read-cancellation.mjs";
import { openDatabaseSSH } from "./database-ssh.mjs";
import {
  encodeRESP,
  redisCommand,
  redisWriteCommand,
} from "./redis-commands.mjs";
// Preserve the established public API while pure consumers use redis-commands.
export {
  encodeRESP,
  redisCommand,
  redisWriteCommand,
} from "./redis-commands.mjs";
import net from "node:net";
import tls from "node:tls";
import { X509Certificate } from "node:crypto";
const MAX_REPLY = 2 * 1024 * 1024,
  MAX_BULK = 1024 * 1024;
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
function validateRedisWriteTarget(input) {
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
}
export async function mutateRedis(input) {
  const command = redisWriteCommand(input);
  validateRedisWriteTarget(input);
  return executeRedis(input, command, true);
}

// Internal host broker boundary. The guard can only refuse/consume the frozen
// slot; it cannot substitute a command or invent an acknowledgement. Caller
// cancellation before dispatch prohibits SET; afterwards this observer owns the
// existing total deadline and local transport close, independent of the worker.
export async function observeNativeRedisSet(
  input,
  { signal, beforeDispatch } = {},
) {
  let dispatched = false;
  try {
    if (typeof beforeDispatch !== "function" || input.ssh !== undefined)
      throw Error("原生写入派发边界无效");
    const command = redisWriteCommand({ ...input, allowWrite: true });
    if (command.length !== 3 || command.some((part) => part.includes("{{")))
      throw Error("原生写入仅支持无选项静态 SET");
    validateRedisWriteTarget(input);
    const result = await executeRedis(input, command, true, signal, {
      beforeDispatch,
      dispatched() {
        dispatched = true;
      },
    });
    return { outcome: "acknowledged-applied", reason: "acknowledged", result };
  } catch (error) {
    return {
      outcome: dispatched ? "unknown" : "not-sent",
      reason:
        error?.code === "NATIVE_WRITE_REVOKED"
          ? "revoked"
          : error?.code === "REDIS_OPERATION_DEADLINE"
            ? "deadline"
            : signal?.aborted
              ? "cancelled"
              : "transport",
    };
  }
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
function validateRedisCA(ca) {
  const invalid = () =>
    Error("Redis CA须为完整PEM证书集合，不得包含无效证书或额外内容");
  if (
    ca !== undefined &&
    (typeof ca !== "string" || Buffer.byteLength(ca) > 65536)
  )
    throw invalid();
  // The existing editor sends an empty CA field for default trust/no TLS.
  if (ca === undefined || ca === "") return;
  const certificates =
    /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\t \r\n]+)-----END CERTIFICATE-----/g;
  const whitespace = /^[\t \r\n]*$/;
  let cursor = 0,
    count = 0;
  for (const match of ca.matchAll(certificates)) {
    if (!whitespace.test(ca.slice(cursor, match.index))) throw invalid();
    const encoded = match[1].replace(/[\t \r\n]/g, "");
    const der = Buffer.from(encoded, "base64");
    if (!encoded || der.toString("base64") !== encoded) throw invalid();
    try {
      // OpenSSL can silently ignore junk PEM blocks and trailing DER bytes.
      // Parse each certificate independently and require the complete bytes.
      if (!new X509Certificate(der).raw.equals(der)) throw invalid();
    } catch {
      throw invalid();
    }
    cursor = match.index + match[0].length;
    count++;
  }
  if (!count || !whitespace.test(ca.slice(cursor))) throw invalid();
}
async function executeRedis(input, command, writing, signal, ownership) {
  checkDatabaseSignal(signal);
  const host = input.host === undefined ? "127.0.0.1" : input.host,
    port = input.port === undefined ? 6379 : Number(input.port),
    database = Number(input.database || 0);
  if (
    typeof host !== "string" ||
    !host.length ||
    host.length > 253 ||
    /[\s\x00-\x1f/\\@]/.test(host) ||
    (input.port !== undefined &&
      !["string", "number"].includes(typeof input.port)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (input.database !== undefined &&
      !["string", "number"].includes(typeof input.database)) ||
    !Number.isInteger(database) ||
    database < 0 ||
    database > 1023
  )
    throw Error("Redis连接地址/数据库索引无效");
  for (const key of ["user", "password"])
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" ||
        !input[key].isWellFormed() ||
        Buffer.byteLength(input[key]) > 8192)
    )
      throw Error("Redis认证参数无效");
  validateRedisCA(input.ca);
  const commands = [];
  if (input.user || input.password)
    commands.push(
      input.user
        ? ["AUTH", input.user, input.password || ""]
        : ["AUTH", input.password],
    );
  if (database) commands.push(["SELECT", String(database)]);
  commands.push(command);
  if (input.ssl !== undefined && typeof input.ssl !== "boolean")
    throw Error("Redis TLS开关无效");
  // Supplied nonempty CA bundles are fully validated before creating context
  // or opening SSH/direct transport; createSecureContext alone is permissive.
  const secureContext = input.ssl
    ? tls.createSecureContext(input.ca ? { ca: input.ca } : {})
    : undefined;
  for (const args of commands) encodeRESP(args);
  // One budget includes SSH, TLS, AUTH, SELECT and the command. The caller
  // cannot abort the transport behind a native SET observer after dispatch.
  const controller = new AbortController();
  let tunnel,
    channelOwner,
    owner,
    failure,
    rejectReply,
    terminal = false,
    writeSent = false;
  const stop = (error) => {
    if (terminal) return;
    failure ??= error;
    controller.abort();
    owner?.close();
    tunnel?.close();
    rejectReply?.(failure);
  };
  const cancel = () => {
    if (!ownership || !writeSent) stop(databaseCancelled());
  };
  const check = () => {
    if (failure) throw failure;
    if (!ownership || !writeSent) checkDatabaseSignal(signal);
  };
  const timeout = Math.min(
    3000,
    Math.max(100, Number(input.timeoutMs) || 3000),
  );
  const timer = setTimeout(
    () =>
      stop(
        Object.assign(Error("Redis查询超时（总时限已到），已断开"), {
          code: "REDIS_OPERATION_DEADLINE",
        }),
      ),
    timeout,
  );
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  let result;
  try {
    check();
    tunnel = await openDatabaseSSH(
      { ...input, type: "redis", host, port },
      { signal: controller.signal },
    );
    if (tunnel) channelOwner = observeDatabaseStream(tunnel.stream);
    check();
    const options = { host, port };
    const socket = input.ssl
      ? tls.connect({
          ...options,
          ...(tunnel ? { socket: tunnel.stream } : {}),
          servername: net.isIP(host) ? undefined : host,
          // Use the logical Redis identity, never the SSH host or loopback.
          checkServerIdentity: (_name, cert) =>
            tls.checkServerIdentity(host, cert),
          rejectUnauthorized: true,
          secureContext,
        })
      : tunnel?.stream || net.connect(options);
    owner =
      !input.ssl && channelOwner ? channelOwner : observeDatabaseStream(socket);
    result = await new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0),
        received = 0,
        index = 0;
      const finish = (error, value) => {
        if (terminal) return;
        if (error) failure ??= error;
        terminal = true;
        clearTimeout(timer);
        failure ? reject(failure) : resolve(value);
      };
      rejectReply = (error) => finish(error);
      const send = () => {
        if (terminal) return;
        check();
        const packet = encodeRESP(commands[index]);
        if (writing && index === commands.length - 1) {
          if (ownership) {
            const checked = ownership.beforeDispatch();
            if (checked !== undefined) {
              if (checked instanceof Promise) checked.catch(() => {});
              throw Error("原生写入派发检查必须同步完成");
            }
            check();
          }
          writeSent = true;
          ownership?.dispatched();
        }
        socket.write(packet);
      };
      const ready = () => {
        try {
          send();
        } catch (error) {
          finish(error);
        }
      };
      socket.on("error", (error) => finish(error));
      socket.on("close", () => finish(Error("Redis连接提前关闭")));
      socket.on("data", (chunk) => {
        if (terminal) return;
        try {
          check();
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
            const value = table(command[0], frame.value);
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
                ...value,
                limit: 1,
              });
            }
            return finish(null, value);
          }
          if (frame.value !== "OK") throw Error("Redis认证或数据库选择失败");
          index++;
          send();
        } catch (error) {
          finish(error);
        }
      });
      if (input.ssl || !tunnel)
        socket.once(input.ssl ? "secureConnect" : "connect", ready);
      else ready(); // SSH channels are already connected; no connect event follows.
    });
  } catch (error) {
    failure ??= error;
  } finally {
    terminal = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    // Destroying the channel/TLS wrapper alone leaves the SSH client alive.
    // Settlement owns BOTH actual local closes, not a remote rollback guarantee.
    owner?.close();
    channelOwner?.close();
    tunnel?.close();
    // ssh2 Channel.destroy() sends EOF/CLOSE rather than destroying a Duplex.
    // Its close event waits for readable EOF; TLS teardown may have paused the
    // channel. Drain only during terminal cleanup so that actual close can fire.
    channelOwner?.stream.resume();
    await Promise.all([owner?.closed, channelOwner?.closed, tunnel?.closed]);
  }
  if (!writing && signal?.aborted) failure ??= databaseCancelled();
  if (failure && writeSent) {
    const cause = failure;
    failure = Error(
      cause.message +
        "；Redis写入结果可能不确定，不能盲目重试，请先核查目标键（不能回滚）",
    );
    failure.code = ownership ? cause.code : "REDIS_WRITE_UNCERTAIN";
  }
  if (failure) throw failure;
  return result;
}
