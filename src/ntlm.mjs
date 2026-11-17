import { createHmac, randomBytes } from "node:crypto";
import md4 from "js-md4";
const signature = Buffer.from("NTLMSSP\0");
const FLAGS = 0xa2888205;
const hmac = (key, data) => createHmac("md5", key).update(data).digest();
function credentials(input) {
  const result = {};
  for (const key of ["username", "password", "domain", "workstation"]) {
    const value = input?.[key] ?? "";
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value) > 4096 ||
      /[\0\r\n]/.test(value)
    )
      throw Error("NTLM凭据字段无效");
    result[key] = value;
  }
  if (!result.username) throw Error("NTLM必须显式填写用户名");
  for (const key of ["domain", "workstation"])
    if (!/^[A-Za-z0-9_.-]{0,255}$/.test(result[key]))
      throw Error("NTLM域/工作站仅支持ASCII名称");
  return result;
}
function field(output, at, value, offset) {
  output.writeUInt16LE(value.length, at);
  output.writeUInt16LE(value.length, at + 2);
  output.writeUInt32LE(offset, at + 4);
  value.copy(output, offset);
  return offset + value.length;
}
const version = Buffer.from([6, 1, 0xb1, 0x1d, 0, 0, 0, 15]);
export function ntlmType1(input) {
  const c = credentials(input),
    domain = Buffer.from(c.domain.toUpperCase(), "ascii"),
    workstation = Buffer.from(c.workstation.toUpperCase(), "ascii");
  const b = Buffer.alloc(40 + domain.length + workstation.length);
  signature.copy(b);
  b.writeUInt32LE(1, 8);
  b.writeUInt32LE(
    (FLAGS |
      (domain.length ? 0x1000 : 0) |
      (workstation.length ? 0x2000 : 0)) >>>
      0,
    12,
  );
  version.copy(b, 32);
  let offset = field(b, 16, domain, 40);
  field(b, 24, workstation, offset);
  return "NTLM " + b.toString("base64");
}
export function parseNtlmChallenge(header) {
  if (typeof header !== "string" || header.length > 32768)
    throw Error("NTLM challenge超过上限");
  const matches = [
    ...header.matchAll(
      /(?:^|,)\s*NTLM\s+([A-Za-z0-9+/]+={0,2})(?=\s*(?:,|$))/gi,
    ),
  ];
  if (matches.length !== 1) throw Error("服务器未返回唯一NTLM challenge");
  const token = matches[0][1];
  if (token.length > 16384 || token.length % 4 !== 0)
    throw Error("NTLM challenge编码无效");
  const b = Buffer.from(token, "base64");
  if (
    b.toString("base64") !== token ||
    b.length < 48 ||
    !b.subarray(0, 8).equals(signature) ||
    b.readUInt32LE(8) !== 2
  )
    throw Error("NTLM challenge结构无效");
  const flags = b.readUInt32LE(20),
    required = 0x00880201;
  if ((flags & required) !== required)
    throw Error("仅支持NTLMv2，不降级到NTLMv1/LM");
  if (flags & 0x40000030) throw Error("暂不支持NTLM会话签名/封装/密钥交换");
  const headerLength = flags & 0x02000000 ? 56 : 48;
  if (b.length < headerLength) throw Error("NTLM版本字段截断");
  const read = (at, allowEmpty = false) => {
    const len = b.readUInt16LE(at),
      max = b.readUInt16LE(at + 2),
      offset = b.readUInt32LE(at + 4);
    if (
      len > 8192 ||
      max < len ||
      (!len && !allowEmpty) ||
      (len && (offset < headerLength || offset + len > b.length))
    )
      throw Error("NTLM字段长度/偏移无效");
    return b.subarray(offset, offset + len);
  };
  read(12, true);
  const info = read(40);
  const seen = new Set();
  let timestamp,
    avFlags = 0,
    ended = false;
  for (let at = 0; at < info.length; ) {
    if (at + 4 > info.length) throw Error("NTLM AV字段截断");
    const id = info.readUInt16LE(at),
      length = info.readUInt16LE(at + 2);
    at += 4;
    if (at + length > info.length || seen.has(id) || seen.size >= 100)
      throw Error("NTLM AV字段无效或重复");
    seen.add(id);
    const value = info.subarray(at, at + length);
    at += length;
    if (id === 0) {
      if (length || info.subarray(at).some((x) => x !== 0))
        throw Error("NTLM AV结束标记无效");
      ended = true;
      break;
    }
    if (
      id >= 8 ||
      (id === 6 && (length !== 4 || ![0, 2].includes(value.readUInt32LE(0))))
    )
      throw Error("服务器要求暂不支持的NTLM AV标志/EPA/通道绑定，不能降级");
    if (id === 6) avFlags = value.readUInt32LE(0);
    if (id === 7) {
      if (length !== 8) throw Error("NTLM时间戳无效");
      timestamp = Buffer.from(value);
    } else if (id !== 6 && (length % 2 || length > 2048))
      throw Error("NTLM名称字段无效");
  }
  if (!ended) throw Error("NTLM AV缺少结束标记");
  return {
    flags,
    message: Buffer.from(b),
    provideMic: Boolean(timestamp || avFlags & 2),
    serverChallenge: Buffer.from(b.subarray(24, 32)),
    targetInfo: Buffer.from(info),
    timestamp,
  };
}
export function ntlmV2Response(input, serverChallenge, targetInfo, fixed = {}) {
  const c = credentials(input);
  if (
    !Buffer.isBuffer(serverChallenge) ||
    serverChallenge.length !== 8 ||
    !Buffer.isBuffer(targetInfo) ||
    targetInfo.length > 8192
  )
    throw Error("NTLM响应输入无效");
  const clientChallenge = fixed.clientChallenge ?? randomBytes(8),
    timestamp = fixed.timestamp ?? Buffer.alloc(8);
  if (
    !Buffer.isBuffer(clientChallenge) ||
    clientChallenge.length !== 8 ||
    !Buffer.isBuffer(timestamp) ||
    timestamp.length !== 8
  )
    throw Error("NTLM随机数/时间戳无效");
  if (!fixed.timestamp)
    timestamp.writeBigUInt64LE((BigInt(Date.now()) + 11644473600000n) * 10000n);
  const hash = Buffer.from(md4.arrayBuffer(Buffer.from(c.password, "utf16le"))),
    key = hmac(
      hash,
      Buffer.from(c.username.toUpperCase() + c.domain, "utf16le"),
    );
  hash.fill(0);
  const blob = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
    timestamp,
    clientChallenge,
    Buffer.alloc(4),
    targetInfo,
    Buffer.alloc(4),
  ]);
  return {
    key,
    lm: fixed.serverTimestamp
      ? Buffer.alloc(24)
      : Buffer.concat([
          hmac(key, Buffer.concat([serverChallenge, clientChallenge])),
          clientChallenge,
        ]),
    nt: Buffer.concat([
      hmac(key, Buffer.concat([serverChallenge, blob])),
      blob,
    ]),
  };
}
// This is the actual host-sent Type1, not a reconstruction from credentials.
function negotiateMessage(header) {
  if (
    typeof header !== "string" ||
    header.length > 16389 ||
    !/^NTLM [A-Za-z0-9+/]+={0,2}$/.test(header)
  )
    throw Error("NTLM MIC缺少有效的原始Type1消息");
  const token = header.slice(5),
    b = Buffer.from(token, "base64");
  if (
    b.toString("base64") !== token ||
    b.length < 32 ||
    !b.subarray(0, 8).equals(signature) ||
    b.readUInt32LE(8) !== 1
  )
    throw Error("NTLM MIC原始Type1消息无效");
  const flags = b.readUInt32LE(12),
    headerLength = flags & 0x02000000 ? 40 : 32;
  if (
    b.length < headerLength ||
    (flags & 0x00080201) !== 0x00080201 ||
    flags & 0x40000030
  )
    throw Error("NTLM MIC原始Type1能力无效");
  for (const at of [16, 24]) {
    const length = b.readUInt16LE(at),
      maximum = b.readUInt16LE(at + 2),
      offset = b.readUInt32LE(at + 4);
    if (
      maximum < length ||
      (length && (offset < headerLength || offset + length > b.length))
    )
      throw Error("NTLM MIC原始Type1字段无效");
  }
  return b;
}
function micTargetInfo(info) {
  const copied = Buffer.from(info);
  for (let at = 0; at < copied.length; ) {
    const id = copied.readUInt16LE(at),
      length = copied.readUInt16LE(at + 2);
    if (id === 6) {
      copied.writeUInt32LE(2, at + 4);
      return copied;
    }
    if (id === 0) {
      if (copied.length + 8 > 8192) throw Error("NTLM MIC目标信息超过上限");
      return Buffer.concat([
        copied.subarray(0, at),
        Buffer.from("0600040002000000", "hex"),
        copied.subarray(at),
      ]);
    }
    at += 4 + length;
  }
  throw Error("NTLM MIC目标信息缺少结束标记");
}
export function ntlmType3(challenge, input, sentType1) {
  // Use the retained, bounded wire message as authoritative. Caller mutation of
  // convenient parsed fields must not change the authenticated transcript.
  if (challenge && Object.hasOwn(challenge, "message")) {
    if (!Buffer.isBuffer(challenge.message) || challenge.message.length > 12288)
      throw Error("NTLM原始Type2消息无效");
    challenge = parseNtlmChallenge(
      "NTLM " + challenge.message.toString("base64"),
    );
  }
  const provideMic = Boolean(challenge.provideMic || challenge.timestamp);
  if (provideMic && !Buffer.isBuffer(challenge.message))
    throw Error("NTLM MIC缺少原始Type2消息");
  const type1 = provideMic ? negotiateMessage(sentType1) : undefined;
  const c = credentials(input),
    r = ntlmV2Response(
      c,
      challenge.serverChallenge,
      provideMic ? micTargetInfo(challenge.targetInfo) : challenge.targetInfo,
      challenge.timestamp
        ? { timestamp: challenge.timestamp, serverTimestamp: true }
        : {},
    );
  let sessionKey;
  try {
    const parts = [
      r.lm,
      r.nt,
      Buffer.from(c.domain, "utf16le"),
      Buffer.from(c.username, "utf16le"),
      Buffer.from(c.workstation, "utf16le"),
      Buffer.alloc(0),
    ];
    const flags = (challenge.flags & FLAGS) >>> 0,
      headerLength = provideMic ? 88 : flags & 0x02000000 ? 72 : 64;
    const b = Buffer.alloc(
      headerLength + parts.reduce((n, x) => n + x.length, 0),
    );
    signature.copy(b);
    b.writeUInt32LE(3, 8);
    b.writeUInt32LE(flags, 60);
    if (flags & 0x02000000) version.copy(b, 64);
    let offset = headerLength;
    parts.forEach((part, index) => {
      offset = field(b, 12 + index * 8, part, offset);
    });
    if (provideMic) {
      sessionKey = hmac(r.key, r.nt.subarray(0, 16));
      hmac(sessionKey, Buffer.concat([type1, challenge.message, b])).copy(
        b,
        72,
      );
    }
    return "NTLM " + b.toString("base64");
  } finally {
    r.key.fill(0);
    sessionKey?.fill(0);
  }
}
