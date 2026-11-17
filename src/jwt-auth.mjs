import { createPrivateKey } from "node:crypto";
import { CompactSign } from "jose";
import { jwtAlgorithms } from "../public/jwt-auth-model.js";
function jsonObject(value, limit, name) {
  if (value === undefined || value === "") value = "{}";
  if (typeof value !== "string" || Buffer.byteLength(value) > limit)
    throw Error(name + " 必须是有界 JSON 对象文本");
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw Error(name + " JSON 无效");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw Error(name + " 必须是 JSON 对象");
  return { text: value, parsed };
}
function secretBytes(auth) {
  if (
    typeof auth.secret !== "string" ||
    !auth.secret ||
    Buffer.byteLength(auth.secret) > 65536
  )
    throw Error("JWT Secret 不能为空且最多64KiB");
  if (
    ![undefined, false, true, "false", "true"].includes(
      auth.isSecretBase64Encoded,
    )
  )
    throw Error("JWT Base64 标识无效");
  if (
    auth.isSecretBase64Encoded !== true &&
    auth.isSecretBase64Encoded !== "true"
  )
    return Buffer.from(auth.secret);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      auth.secret,
    )
  )
    throw Error("JWT Secret 不是规范 Base64");
  const decoded = Buffer.from(auth.secret, "base64");
  if (decoded.toString("base64") !== auth.secret)
    throw Error("JWT Secret Base64 编码无效");
  return decoded;
}
/** Sign locally using explicit credentials. No login, key lookup or file reads. */
export async function jwtAuthorization(auth) {
  const algorithm = auth.algorithm || "HS256";
  if (!jwtAlgorithms.includes(algorithm))
    throw Error("JWT 不支持该签名算法（禁止 none）");
  const location = auth.addTokenTo || "header";
  if (!["header", "queryParam"].includes(location))
    throw Error("JWT 发送位置无效");
  const prefix = auth.headerPrefix ?? "Bearer",
    queryKey = auth.queryParamKey ?? "token";
  if (
    location === "header" &&
    (typeof prefix !== "string" ||
      prefix.length > 128 ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]*$/.test(prefix))
  )
    throw Error("JWT Header 前缀无效");
  if (
    location === "queryParam" &&
    (typeof queryKey !== "string" ||
      !queryKey ||
      queryKey.length > 128 ||
      /[\u0000-\u0020\u007f]/.test(queryKey))
  )
    throw Error("JWT Query 参数名无效");
  const payload = jsonObject(auth.payload, 8192, "JWT Payload"),
    custom = jsonObject(auth.header, 2048, "JWT Header").parsed;
  for (const key of Object.keys(custom))
    if (!["alg", "typ", "cty", "kid"].includes(key))
      throw Error("JWT Header 不支持字段 " + key);
  if (Object.hasOwn(custom, "alg") && custom.alg !== algorithm)
    throw Error("JWT Header alg 与所选算法不一致");
  for (const key of ["typ", "cty", "kid"])
    if (
      Object.hasOwn(custom, key) &&
      (typeof custom[key] !== "string" ||
        !custom[key] ||
        custom[key].length > 500)
    )
      throw Error("JWT Header 字段无效 " + key);
  const bytes = secretBytes(auth),
    bits = Number(algorithm.slice(2));
  let key;
  if (algorithm.startsWith("HS")) {
    if (/-----BEGIN [A-Z ]*KEY-----/.test(bytes.toString()))
      throw Error("JWT HMAC 不接受 PEM 密钥，避免算法混淆");
    if (bytes.length < bits / 8)
      throw Error("JWT HMAC 密钥字节数至少为 " + bits / 8);
    key = bytes;
  } else {
    const pem = bytes.toString("utf8").trim();
    if (!/^-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(pem))
      throw Error("JWT 需要内联 PEM 私钥，不读取文件路径");
    if (
      /^Proc-Type:\s*4,ENCRYPTED/m.test(pem) ||
      (auth.passphrase !== undefined && auth.passphrase !== "")
    )
      throw Error("JWT 暂不支持加密私钥或私钥口令");
    try {
      key = createPrivateKey({
        key: pem,
        format: "pem",
      });
    } catch {
      throw Error("JWT 私钥或口令无效");
    }
    if (algorithm.startsWith("ES")) {
      const curve = { 256: "prime256v1", 384: "secp384r1", 512: "secp521r1" }[
        bits
      ];
      if (
        key.asymmetricKeyType !== "ec" ||
        key.asymmetricKeyDetails?.namedCurve !== curve
      )
        throw Error("JWT EC 私钥曲线与算法不匹配");
    } else if (
      key.asymmetricKeyType !== "rsa" ||
      !Number.isInteger(key.asymmetricKeyDetails?.modulusLength) ||
      key.asymmetricKeyDetails.modulusLength < 2048 ||
      key.asymmetricKeyDetails.modulusLength > 8192
    )
      throw Error("JWT RSA 私钥必须为2048至8192位的普通RSA密钥");
  }
  const token = await new CompactSign(Buffer.from(payload.text))
    .setProtectedHeader({ typ: "JWT", ...custom, alg: algorithm })
    .sign(key);
  if (token.length > 16384) throw Error("JWT 输出超过16KiB");
  return {
    token,
    in: location === "header" ? "header" : "query",
    key: location === "header" ? "authorization" : queryKey,
    value: location === "header" ? (prefix ? prefix + " " : "") + token : token,
  };
}
