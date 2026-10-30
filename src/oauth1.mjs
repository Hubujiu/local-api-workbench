import OAuth from "node-oauth1";
import { oauth1ParameterPolicy } from "../public/oauth1-policy-model.js";
export { oauth1ParameterPolicy } from "../public/oauth1-policy-model.js";
import {
  createHash,
  createHmac,
  randomBytes,
  createPrivateKey,
  sign,
  constants,
} from "node:crypto";
export const oauthEncode = (value) =>
  encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
function buildOAuth1(url, method, headers, body, auth, policy, bodyType) {
  if (policy) auth = { ...auth, parameterPolicy: policy };
  const target = new URL(url);
  const signatureMethod = auth.signatureMethod || "HMAC-SHA1";
  const algorithm = { "HMAC-SHA1": "sha1", "HMAC-SHA256": "sha256" }[
    signatureMethod
  ];
  if (!algorithm && signatureMethod !== "RSA-SHA1")
    throw Error("OAuth1仅支持HMAC-SHA1/HMAC-SHA256/RSA-SHA1");
  if (!auth.consumerKey) throw Error("OAuth1 Consumer Key不能为空");
  const timestamp = String(auth.timestamp || Math.floor(Date.now() / 1000));
  if (!/^[1-9][0-9]*$/.test(timestamp))
    throw Error("OAuth1时间戳必须为正整数秒");
  const params = {
    oauth_consumer_key: String(auth.consumerKey),
    oauth_nonce: String(auth.nonce || randomBytes(16).toString("hex")),
    oauth_signature_method: signatureMethod,
    oauth_timestamp: timestamp,
  };
  if (auth.accessToken || policy?.includeEmptyParams)
    params.oauth_token = String(auth.accessToken || "");
  if (policy?.includeEmptyParams)
    params.oauth_version = String(auth.version || "");
  if (auth.callback) params.oauth_callback = String(auth.callback);
  if (auth.verifier) params.oauth_verifier = String(auth.verifier);
  if (auth.version) {
    if (auth.version !== "1.0") throw Error("OAuth1版本只能为1.0或留空");
    params.oauth_version = "1.0";
  }
  const media = String(headers["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const form = policy
    ? bodyType === "urlencoded"
    : media === "application/x-www-form-urlencoded";
  if (policy && form !== (media === "application/x-www-form-urlencoded"))
    throw Error("OAuth1 bodyType 与 Content-Type 不一致");
  const placement =
    !policy || policy.placement === "header"
      ? "header"
      : form && ["POST", "PUT"].includes(String(method).toUpperCase())
        ? "form"
        : "query";
  if (
    policy &&
    placement === "header" &&
    policy.includeEmptyParams &&
    (!params.oauth_token || !params.oauth_version)
  )
    throw Error("OAuth1 Header 不接受签名但不可见的空核心参数");
  if (policy?.includeBodyHash && !form) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
    if (bodyType === "form-data" && bytes.length)
      throw Error("OAuth1 multipart 正文散列尚未支持");
    params.oauth_body_hash = createHash(
      signatureMethod === "HMAC-SHA256" ? "sha256" : "sha1",
    )
      .update(bytes)
      .digest("base64");
  }
  const pairs = [...target.searchParams];
  if (form)
    pairs.push(
      ...new URLSearchParams(
        Buffer.isBuffer(body) ? body.toString("utf8") : String(body || ""),
      ),
    );
  if (pairs.some(([key]) => key.startsWith("oauth_")))
    throw Error("OAuth1协议字段请在认证面板设置，不要混入Query/Body");
  if (pairs.length > 10000) throw Error("OAuth1参数过多");
  pairs.push(...Object.entries(params));
  // Audited Apache-2.0 dependency is used only with fresh scalar string pairs.
  // Never call its nonce, URL parser, header, registry or signing helpers.
  const normalized = OAuth.SignatureMethod.normalizeParameters(
    pairs.map(([key, value]) => [String(key), String(value)]),
  );
  let authority = target.host;
  if (headers.host) {
    if (/[\s\/@?#]/.test(headers.host)) throw Error("OAuth1 Host无效");
    authority = new URL(target.protocol + "//" + headers.host).host;
  }
  const baseURI = target.protocol + "//" + authority + target.pathname;
  const baseString = [String(method).toUpperCase(), baseURI, normalized]
    .map(oauthEncode)
    .join("&");
  const key =
    oauthEncode(auth.consumerSecret || "") +
    "&" +
    oauthEncode(auth.tokenSecret || "");
  let signature;
  if (signatureMethod === "RSA-SHA1") {
    if (
      typeof auth.privateKey !== "string" ||
      auth.privateKey.length > 32768 ||
      !/^-----BEGIN (?:RSA |ENCRYPTED )?PRIVATE KEY-----/.test(
        auth.privateKey.trim(),
      )
    )
      throw Error("OAuth1 RSA需要不超过32KiB的内联PEM私钥，不读取文件路径");
    try {
      const privateKey = createPrivateKey({
        key: auth.privateKey,
        format: "pem",
        passphrase: auth.privateKeyPassphrase || undefined,
      });
      if (privateKey.asymmetricKeyType !== "rsa") throw Error("Wrong key type");
      signature = sign("RSA-SHA1", Buffer.from(baseString), {
        key: privateKey,
        padding: constants.RSA_PKCS1_PADDING,
      }).toString("base64");
    } catch {
      throw Error("OAuth1 RSA私钥无效、密码错误或当前环境不支持RSA-SHA1");
    }
  } else
    signature = createHmac(algorithm, key).update(baseString).digest("base64");
  const protocol = { ...params, oauth_signature: signature };
  const headerParams = auth.realm
    ? { realm: String(auth.realm), ...protocol }
    : protocol;
  let header;
  if (placement === "header") {
    if (
      policy &&
      Object.values(headerParams).some((value) => value.trim() !== value)
    )
      throw Error("OAuth1 Header 字段不能含边缘空白");
    const raw = policy?.headerEncoding === "raw";
    if (
      raw &&
      Object.values(headerParams).some((value) =>
        /[^\x20-\x7e]|["\\]/.test(value),
      )
    )
      throw Error("OAuth1 Header 原文仅支持安全 ASCII 字段");
    header =
      "OAuth " +
      Object.entries(headerParams)
        .map(
          ([key, value]) =>
            oauthEncode(key) + '="' + (raw ? value : oauthEncode(value)) + '"',
        )
        .join(", ");
  }
  return { header, baseString, normalized, signature, protocol, placement };
}

export function oauth1Authorization(url, method, headers, body, auth = {}) {
  if (oauth1ParameterPolicy(auth))
    throw Error("OAuth1 parameterPolicy 须使用请求签名入口");
  const result = buildOAuth1(url, method, headers, body, auth);
  // Preserve the established public helper result shape.
  return {
    header: result.header,
    baseString: result.baseString,
    normalized: result.normalized,
    signature: result.signature,
  };
}

export function oauth1Request(
  url,
  method,
  headers,
  body,
  auth = {},
  { bodyType = "none" } = {},
) {
  const policy = oauth1ParameterPolicy(auth);
  if (policy && body && Buffer.byteLength(body) > 8 * 1024 * 1024)
    throw Error("请求体超过 8 MiB");
  const signed = buildOAuth1(
    url,
    method,
    headers,
    body,
    auth,
    policy,
    bodyType,
  );
  const target = new URL(url),
    outputHeaders = { ...headers };
  delete outputHeaders.authorization;
  if (signed.placement === "header")
    outputHeaders.authorization = signed.header;
  else {
    const encoded = Object.entries(signed.protocol)
      .map(([key, value]) => oauthEncode(key) + "=" + oauthEncode(value))
      .join("&");
    if (signed.placement === "query") {
      const existing = target.search.slice(1);
      target.search = (existing ? existing + "&" : "") + encoded;
    } else {
      const existing = Buffer.isBuffer(body)
        ? body.toString("utf8")
        : String(body ?? "");
      body = (existing ? existing + "&" : "") + encoded;
      if (Buffer.byteLength(body) > 8 * 1024 * 1024)
        throw Error("请求体超过 8 MiB");
      outputHeaders["content-length"] = Buffer.byteLength(body);
    }
  }
  return { ...signed, url: target.href, headers: outputHeaders, body };
}
