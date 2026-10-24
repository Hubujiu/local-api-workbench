import WebSocket from "ws";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { createSecureContext } from "node:tls";
export function websocketConfiguration(input) {
  if (typeof input.url !== "string" || input.url.length > 8192)
    throw Error("WebSocket 地址无效");
  const url = new URL(input.url);
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw Error("必须使用无内嵌凭据的 ws:// 或 wss:// 地址");
  const protocols = input.protocols ?? [];
  if (
    !Array.isArray(protocols) ||
    protocols.length > 10 ||
    new Set(protocols).size !== protocols.length ||
    protocols.some(
      (p) =>
        typeof p !== "string" ||
        p.length > 128 ||
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(p),
    )
  )
    throw Error("WebSocket 子协议无效");
  const headers = {};
  if (input.headers !== undefined) {
    if (
      !input.headers ||
      typeof input.headers !== "object" ||
      Array.isArray(input.headers)
    )
      throw Error("WebSocket Headers 无效");
    const entries = Object.entries(input.headers);
    if (entries.length > 50) throw Error("WebSocket Headers 最多50项");
    const names = new Set();
    for (const [key, value] of entries) {
      const name = key.toLowerCase();
      validateHeaderName(key);
      if (typeof value !== "string") throw Error("WebSocket Header 值须为文本");
      validateHeaderValue(key, value);
      if (
        names.has(name) ||
        [
          "host",
          "connection",
          "upgrade",
          "content-length",
          "transfer-encoding",
          "proxy-authorization",
        ].includes(name) ||
        name.startsWith("sec-websocket-")
      )
        throw Error("WebSocket Header 重复或属于协议保留字段");
      names.add(name);
      Object.defineProperty(headers, key, { value, enumerable: true });
    }
    if (Buffer.byteLength(JSON.stringify(headers)) > 8192)
      throw Error("WebSocket Headers 超过8KiB");
  }
  let tls = {};
  if (input.tls !== undefined) {
    if (
      url.protocol !== "wss:" ||
      !input.tls ||
      typeof input.tls !== "object" ||
      Array.isArray(input.tls) ||
      Object.keys(input.tls).some((k) => !["ca", "cert", "key"].includes(k))
    )
      throw Error("WebSocket TLS 配置无效，不能关闭证书校验");
    for (const [key, value] of Object.entries(input.tls)) {
      if (
        typeof value !== "string" ||
        !value.trim() ||
        Buffer.byteLength(value) > 65536
      )
        throw Error("WebSocket TLS 材料无效或超限");
      tls[key] = value;
    }
    if (Boolean(tls.key) !== Boolean(tls.cert))
      throw Error("WebSocket mTLS 证书和私钥须同时提供");
    createSecureContext(tls);
  }
  return {
    url,
    protocols,
    options: {
      ...tls,
      headers,
      rejectUnauthorized: true,
      handshakeTimeout: 3000,
      maxPayload: 1024 * 1024,
      followRedirects: false,
      perMessageDeflate: false,
      agent: false,
    },
  };
}
export function openWebSocket(input) {
  const { url, protocols, options } = websocketConfiguration(input);
  return new WebSocket(url, protocols, options);
}
