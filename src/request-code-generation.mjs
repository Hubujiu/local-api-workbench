import { snippetz } from "@scalar/snippetz";
import { prepareLiteralHTTPExport } from "./core.mjs";

const supported = new Set(["node/fetch", "python/python3", "go/native"]);
const unsafeHeaders = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function assertCodeTarget(target, client) {
  if (
    typeof target !== "string" ||
    typeof client !== "string" ||
    !supported.has(target + "/" + client)
  )
    throw Error("暂不支持此代码生成目标");
}

// Produce code as text only. The caller must never execute generated code.
export function generateRequestCode(input, target, client, options = {}) {
  assertCodeTarget(target, client);
  const { request, url, headers } = prepareLiteralHTTPExport(input, options);
  if (url.username || url.password)
    throw Error("代码示例暂不支持 URL 内的认证信息");
  if (request.proxy || request.httpVersion !== "1.1")
    throw Error("代码示例暂不支持代理或指定 HTTP/2");
  if (request.auth.type === "digest")
    throw Error("代码示例暂不支持 Digest 认证");
  if (request.bodyType === "form-data")
    throw Error("代码示例暂不支持 multipart 正文");
  if (/[\x00-\x1f\x7f'"\\\u2028\u2029]/u.test(url.href))
    throw Error("代码生成器不能安全表达此 URL");
  if (request.auth.type === "basic")
    headers.authorization =
      "Basic " +
      Buffer.from(
        (request.auth.username || "") + ":" + (request.auth.password || ""),
        "utf8",
      ).toString("base64");
  const rows = [];
  for (const [name, value] of Object.entries(headers)) {
    if (
      unsafeHeaders.has(name.toLowerCase()) ||
      Object.hasOwn(Object.prototype, name) ||
      name === "prototype"
    )
      throw Error("代码示例暂不支持控制传输的请求头");
    if (Array.isArray(value) && value.length !== 1)
      throw Error("代码示例暂不支持重复请求头");
    rows.push({ name, value: Array.isArray(value) ? value[0] : value });
  }
  let text;
  if (request.bodyType === "urlencoded")
    text = new URLSearchParams(
      request.form
        .filter((v) => v.enabled !== false)
        .map((v) => [v.key, v.value]),
    ).toString();
  else if (request.bodyType !== "none") text = request.body;
  if (text !== undefined && ["GET", "HEAD"].includes(request.method))
    throw Error("代码示例暂不支持 GET 或 HEAD 正文");
  if (
    target === "python" &&
    text !== undefined &&
    /[^\x20-\x7e\t\n\r]/u.test(text)
  )
    throw Error("Python 标准库示例暂不支持非 ASCII 或特殊控制字符正文");
  const code = snippetz().print(target, client, {
    method: request.method,
    url: url.href,
    headers: rows,
    queryString: [],
    ...(text === undefined
      ? {}
      : {
          postData: {
            mimeType:
              target === "python" ? "application/octet-stream" : "text/plain",
            text,
          },
        }),
  });
  if (typeof code !== "string" || Buffer.byteLength(code) > 1024 * 1024)
    throw Error("生成的代码无效或超过 1 MiB");
  return {
    target,
    client,
    code,
    warnings: [
      "代码可能包含认证信息，请勿公开分享。",
      "示例不运行前后置脚本；超时、重定向、代理、TLS 和客户端默认请求头可能与工作台不同。",
    ],
  };
}
