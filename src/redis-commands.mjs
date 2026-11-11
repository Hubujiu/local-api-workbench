// Pure command policy shared by inert imports/task validation and the transport.
// Keep SSH, sockets, credentials and optional native drivers out of this module.
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
        (typeof args[i] === "string" && !args[i].isWellFormed()) ||
        (typeof args[i] === "number" &&
          (!Number.isFinite(args[i]) ||
            (Number.isInteger(args[i]) && !Number.isSafeInteger(args[i])))) ||
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
