// Only errors created here may carry local diagnostic text into a session.
// Peer messages, descriptions, data, stacks and causes are never serialized.
const localDiagnostics = new WeakMap();
export function socketIOError(message) {
  const error = Error(message);
  localDiagnostics.set(error, message);
  return error;
}
const categories = new Map([
  ["timeout", "Socket.IO连接超时"],
  ["websocket error", "Socket.IO WebSocket传输失败"],
  ["xhr poll error", "Socket.IO polling传输失败"],
  ["xhr post error", "Socket.IO polling传输失败"],
  ["fetch failed", "Socket.IO polling传输失败"],
  ["Invalid Engine.IO handshake", "Socket.IO Engine.IO握手无效"],
  ["Invalid Engine.IO 3 packet", "Socket.IO Engine.IO 3 packet无效"],
  ["Invalid Engine.IO 3 data", "Socket.IO Engine.IO 3 data无效"],
  ["WebSocket setup failed", "Socket.IO WebSocket初始化失败"],
  ["ping timeout", "Socket.IO心跳超时"],
  ["transport close", "Socket.IO传输已关闭"],
  ["transport error", "Socket.IO传输失败"],
  ["parse error", "Socket.IO消息解析失败"],
]);
const codes = new Map([
  ["ERR_ENCODING_INVALID_ENCODED_DATA", "Socket.IO响应UTF-8编码无效"],
  ["ECONNREFUSED", "Socket.IO连接被拒绝"],
  ["ENOTFOUND", "Socket.IO主机解析失败"],
  ["ETIMEDOUT", "Socket.IO连接超时"],
  ["CERT_HAS_EXPIRED", "Socket.IO TLS证书验证失败"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "Socket.IO TLS证书验证失败"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "Socket.IO TLS证书验证失败"],
]);
export function socketIODiagnostic(error) {
  // One bounded wrapper level supports Engine.IO transport errors. The WeakMap
  // cannot be forged by a peer's JSON fields or a matching error message.
  for (const value of [error, error?.description]) {
    const local = localDiagnostics.get(value);
    if (local) return local;
  }
  for (const value of [error, error?.description]) {
    const category = codes.get(value?.code);
    if (category) return category;
  }
  return (
    categories.get(typeof error === "string" ? error : error?.message) ||
    "Socket.IO连接或协议失败（对端诊断已隐藏）"
  );
}
