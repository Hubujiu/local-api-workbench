import { normalizeHandshake } from "./protocol-handshake.mjs";
import { protocolRequestOptions } from "./protocol-request-options.mjs";
import { protocolPayload } from "./protocol-payload.mjs";
import { randomUUID } from "node:crypto";
export function normalizeProtocol(input) {
  if (
    input?.id !== undefined &&
    (typeof input.id !== "string" || !/^[a-zA-Z0-9_.-]{1,200}$/.test(input.id))
  )
    throw Error("协议定义ID无效");
  if (!input || !["sse", "websocket", "tcp"].includes(input.type))
    throw Error("协议定义类型无效");
  if (input.headers !== undefined || input.tls !== undefined)
    throw Error("协议定义不保存认证 Headers 或 TLS 私钥材料");
  const url = String(input.url || "");
  if (input.type === "tcp") {
    if (
      !url ||
      /[\s/]/.test(url) ||
      !Number.isInteger(Number(input.port)) ||
      Number(input.port) < 1 ||
      Number(input.port) > 65535
    )
      throw Error("TCP连接地址或端口无效");
  } else {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw Error("协议URL无效");
    }
    if (parsed.username || parsed.password || parsed.hash)
      throw Error("协议定义地址不能内嵌凭据或片段");
    if (
      !(input.type === "sse" ? ["http:", "https:"] : ["ws:", "wss:"]).includes(
        parsed.protocol,
      )
    )
      throw Error("协议URL类型不匹配");
  }
  if (
    input.receiveEncoding !== undefined &&
    (input.type !== "tcp" ||
      !["utf8", "base64", "hex"].includes(input.receiveEncoding))
  )
    throw Error("协议接收编码无效");
  if (input.message !== undefined) {
    if (input.type === "sse") throw Error("SSE 定义不支持发送消息");
    protocolPayload(input.message);
  }
  const handshake = normalizeHandshake(input.handshake, input.type);
  const requestOptions = protocolRequestOptions(input);
  if (input.duration !== undefined) {
    if (
      !Number.isInteger(input.duration) ||
      input.duration < 100 ||
      input.duration > 30000
    )
      throw Error("协议默认时限须为100至30000毫秒");
    requestOptions.duration = input.duration;
  }
  return {
    ...requestOptions,
    ...(handshake === undefined ? {} : { handshake }),
    ...(input.receiveEncoding !== undefined
      ? { receiveEncoding: input.receiveEncoding }
      : {}),
    ...(input.message !== undefined
      ? { message: structuredClone(input.message) }
      : {}),
    id: input.id || randomUUID(),
    name: String(input.name || "新连接").slice(0, 200),
    folder: String(input.folder || ""),
    type: input.type,
    url,
    port: input.type === "tcp" ? Number(input.port) : undefined,
  };
}
