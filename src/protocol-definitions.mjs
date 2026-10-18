import { randomUUID } from "node:crypto";
export function normalizeProtocol(input) {
  if (
    input?.id !== undefined &&
    (typeof input.id !== "string" || !/^[a-zA-Z0-9_.-]{1,200}$/.test(input.id))
  )
    throw Error("协议定义ID无效");
  if (!input || !["sse", "websocket", "tcp"].includes(input.type))
    throw Error("协议定义类型无效");
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
    if (
      !(input.type === "sse" ? ["http:", "https:"] : ["ws:", "wss:"]).includes(
        parsed.protocol,
      )
    )
      throw Error("协议URL类型不匹配");
  }
  return {
    id: input.id || randomUUID(),
    name: String(input.name || "新连接").slice(0, 200),
    folder: String(input.folder || ""),
    type: input.type,
    url,
    port: input.type === "tcp" ? Number(input.port) : undefined,
  };
}
