import { randomUUID } from "node:crypto";
import { asapAlgorithms } from "../public/asap-auth-model.js";
import { jwtAuthorization } from "./jwt-auth.mjs";
function identifier(value, label, max) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    !/^[A-Za-z0-9_.+\/-]+$/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw Error("ASAP " + label + " 标识无效");
  return value;
}
function audience(input) {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    Buffer.byteLength(input) > 4096
  )
    throw Error("ASAP Audience 不能为空且必须为字符串");
  let value = input;
  if (input.trim().startsWith("[")) {
    try {
      value = JSON.parse(input);
    } catch {
      throw Error("ASAP Audience 数组JSON无效");
    }
  }
  const list = Array.isArray(value) ? value : [value];
  if (
    !list.length ||
    list.length > 10 ||
    list.some(
      (item) => typeof item !== "string" || !item.trim() || item.length > 200,
    )
  )
    throw Error("ASAP Audience 最多10项，每项最多200字符");
  return value;
}
/** Client-side signing only; never registers services or discovers/uploads keys. */
export async function asapAuthorization(
  auth,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (auth.exp !== undefined && auth.exp !== "")
    throw Error("ASAP请明确使用ttlSeconds，不能自动解释导入的exp字段");
  const algorithm = auth.alg || "RS256";
  if (!asapAlgorithms.includes(algorithm))
    throw Error("ASAP 仅允许非对称签名算法，禁止 HMAC/none");
  const iss = identifier(auth.iss, "Issuer", 200),
    kid = identifier(auth.kid, "Key ID", 500);
  if (!kid.startsWith(iss + "/"))
    throw Error("ASAP Key ID 必须以 Issuer/ 开头");
  const aud = audience(auth.aud);
  const ttl =
    auth.ttlSeconds === undefined || auth.ttlSeconds === ""
      ? 60
      : auth.ttlSeconds;
  if (
    (typeof ttl !== "number" &&
      (typeof ttl !== "string" || !/^\d+$/.test(ttl))) ||
    !Number.isInteger(Number(ttl)) ||
    Number(ttl) < 1 ||
    Number(ttl) > 3600
  )
    throw Error("ASAP 有效期必须为1至3600秒");
  if (
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 0 ||
    !Number.isSafeInteger(nowSeconds + Number(ttl))
  )
    throw Error("ASAP 当前时钟无效");
  const exp = nowSeconds + Number(ttl);
  const text =
    auth.claims === undefined || auth.claims === "" ? "{}" : auth.claims;
  if (typeof text !== "string" || Buffer.byteLength(text) > 4096)
    throw Error("ASAP Additional claims 最多4KiB JSON对象");
  let claims;
  try {
    claims = JSON.parse(text);
  } catch {
    throw Error("ASAP Additional claims JSON无效");
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims))
    throw Error("ASAP Additional claims 必须为JSON对象");
  for (const key of ["iss", "aud", "sub", "iat", "exp", "jti"])
    if (Object.hasOwn(claims, key))
      throw Error("ASAP Additional claims 不得覆盖 " + key);
  if (
    Object.hasOwn(claims, "nbf") &&
    (!Number.isSafeInteger(claims.nbf) || claims.nbf < 0 || claims.nbf > exp)
  )
    throw Error("ASAP nbf 必须为不晚于到期时间的整数时间戳");
  if (
    auth.sub !== undefined &&
    (typeof auth.sub !== "string" || auth.sub.length > 500)
  )
    throw Error("ASAP Subject 无效");
  const payload = {
    ...claims,
    iss,
    aud,
    ...(auth.sub ? { sub: auth.sub } : {}),
    iat: nowSeconds,
    exp,
    jti: randomUUID(),
  };
  return jwtAuthorization({
    algorithm,
    secret: auth.privateKey,
    payload: JSON.stringify(payload),
    header: JSON.stringify({ kid }),
    addTokenTo: "header",
    headerPrefix: "Bearer",
  });
}
