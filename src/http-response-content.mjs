import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

export function responseContentDecoder(method, status, encoding) {
  // RFC 9110 section 6.4.1: these responses have no message content.
  // Content-Encoding can describe the selected representation (not wire bytes).
  // Keep consuming the original response so end/error/cancellation still apply.
  if (
    method === "HEAD" ||
    (status >= 100 && status < 200) ||
    status === 204 ||
    status === 304
  )
    return null;
  // 205 is not a no-message-body framing exception. Do not hide malformed
  // encoded content there or on ordinary zero-length responses. CONNECT is
  // rejected by request normalization; this helper does not add tunnel support.
  return encoding === "gzip"
    ? createGunzip()
    : encoding === "deflate"
      ? createInflate()
      : encoding === "br"
        ? createBrotliDecompress()
        : null;
}
