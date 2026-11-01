import { normalizeTCPDelimiter } from "./tcp-delimiter.mjs";
// Shared by saved definitions, one-shot execution, plans and live SSE sessions.
// No source application code is used here.
export function protocolRequestOptions(input) {
  const result = {};
  if (input.method !== undefined || input.body !== undefined) {
    if (input.type !== "sse") throw Error("仅 SSE 支持 HTTP 方法与正文");
    const method = input.method ?? "GET";
    if (!["GET", "POST"].includes(method))
      throw Error("SSE 方法仅支持 GET/POST");
    if (
      input.body !== undefined &&
      (typeof input.body !== "string" ||
        !input.body.isWellFormed() ||
        Buffer.byteLength(input.body) > 65536)
    )
      throw Error("SSE 正文须为有效 UTF-8 文本且最多64KiB");
    if (method === "GET" && input.body !== undefined)
      throw Error("GET SSE 不支持正文");
    result.method = method;
    if (input.body !== undefined) result.body = input.body;
  }
  if (input.completion !== undefined) {
    if (
      input.type !== "tcp" ||
      !["end", "first-data", "delimiter"].includes(input.completion)
    )
      throw Error("TCP 完成规则仅支持 end/first-data/delimiter");
    result.completion = input.completion;
  }
  if (input.completion === "delimiter")
    result.delimiterHex = normalizeTCPDelimiter(input.delimiterHex);
  else if (input.delimiterHex !== undefined)
    throw Error("TCP 结束标记仅用于 delimiter 完成规则");
  return result;
}
