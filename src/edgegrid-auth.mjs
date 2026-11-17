import { createHash, createHmac, randomUUID } from "node:crypto";
import { validateHeaderName } from "node:http";
const hmac = (key, value) =>
  createHmac("sha256", key).update(value).digest("base64");
export function edgegridAuthorization(url, method, headers, body, auth = {}) {
  for (const key of ["clientToken", "clientSecret", "accessToken"])
    if (typeof auth[key] !== "string" || !auth[key] || auth[key].length > 8192)
      throw Error("EdgeGrid缺少或无效 " + key);
  const timestamp =
    auth.timestamp ||
    new Date()
      .toISOString()
      .replaceAll("-", "")
      .replace(/\.\d{3}Z$/, "+0000");
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})\+0000$/.exec(
    timestamp,
  );
  if (
    !match ||
    !Number.isFinite(
      Date.parse(
        match[1] +
          "-" +
          match[2] +
          "-" +
          match[3] +
          "T" +
          match[4] +
          ":" +
          match[5] +
          ":" +
          match[6] +
          "Z",
      ),
    )
  )
    throw Error("EdgeGrid时间格式应为YYYYMMDDTHH:mm:ss+0000");
  const nonce = auth.nonce || randomUUID();
  for (const value of [auth.clientToken, auth.accessToken, nonce])
    if (
      typeof value !== "string" ||
      value.length > 8192 ||
      !/^[\x21-\x7e]+$/.test(value) ||
      value.includes(";")
    )
      throw Error("EdgeGrid认证字段含非法字符");
  const limit =
    auth.maxBodySize === undefined || auth.maxBodySize === ""
      ? 131072
      : Number(auth.maxBodySize);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 * 1024 * 1024)
    throw Error("EdgeGrid Hash上限须为1至8MiB字节");
  const names =
    typeof auth.headersToSign === "string"
      ? auth.headersToSign
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : auth.headersToSign || [];
  if (!Array.isArray(names) || names.length > 100)
    throw Error("EdgeGrid待签名Header列表无效");
  const normalized = names.map((name) => {
    if (typeof name !== "string") throw Error("Header名称无效");
    validateHeaderName(name);
    return name.toLowerCase();
  });
  if (new Set(normalized).size !== normalized.length)
    throw Error("EdgeGrid签名Header重复");
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
  const canonical = normalized
    .filter((name) => Object.hasOwn(lower, name))
    .map((name) => name + ":" + lower[name].trim().replace(/\s+/g, " "))
    .join("\t");
  const target = new URL(url);
  let host = lower.host || target.host;
  if (auth.baseURL) {
    const base = new URL(auth.baseURL);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password
    )
      throw Error("EdgeGrid baseURL无效");
    host = base.host;
  }
  if (/[\s\/@?#]/.test(host)) throw Error("EdgeGrid Host无效");
  const bytes =
    body == null
      ? Buffer.alloc(0)
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(body);
  const bodyHash =
    String(method).toUpperCase() === "POST" && bytes.length
      ? createHash("sha256").update(bytes.subarray(0, limit)).digest("base64")
      : "";
  const prefix =
    "EG1-HMAC-SHA256 client_token=" +
    auth.clientToken +
    ";access_token=" +
    auth.accessToken +
    ";timestamp=" +
    timestamp +
    ";nonce=" +
    nonce +
    ";";
  const canonicalRequest = [
    String(method).toUpperCase(),
    target.protocol.slice(0, -1),
    host,
    target.pathname + target.search,
    canonical,
    bodyHash,
    prefix,
  ].join("\t");
  return (
    prefix +
    "signature=" +
    hmac(hmac(auth.clientSecret, timestamp), canonicalRequest)
  );
}
