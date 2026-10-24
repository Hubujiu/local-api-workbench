import {
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
export function oauth1Authorization(url, method, headers, body, auth = {}) {
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
  if (auth.accessToken) params.oauth_token = String(auth.accessToken);
  if (auth.callback) params.oauth_callback = String(auth.callback);
  if (auth.verifier) params.oauth_verifier = String(auth.verifier);
  if (auth.version) {
    if (auth.version !== "1.0") throw Error("OAuth1版本只能为1.0或留空");
    params.oauth_version = "1.0";
  }
  const pairs = [...target.searchParams];
  if (
    String(headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase() === "application/x-www-form-urlencoded"
  )
    pairs.push(
      ...new URLSearchParams(
        Buffer.isBuffer(body) ? body.toString("utf8") : String(body || ""),
      ),
    );
  if (pairs.some(([key]) => key.startsWith("oauth_")))
    throw Error("OAuth1协议字段请在认证面板设置，不要混入Query/Body");
  if (pairs.length > 10000) throw Error("OAuth1参数过多");
  pairs.push(...Object.entries(params));
  const normalized = pairs
    .map(([k, v]) => [oauthEncode(k), oauthEncode(v)])
    .sort((a, b) =>
      a[0] < b[0]
        ? -1
        : a[0] > b[0]
          ? 1
          : a[1] < b[1]
            ? -1
            : a[1] > b[1]
              ? 1
              : 0,
    )
    .map(([k, v]) => k + "=" + v)
    .join("&");
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
  const headerParams = auth.realm
    ? { realm: String(auth.realm), ...params, oauth_signature: signature }
    : { ...params, oauth_signature: signature };
  return {
    header:
      "OAuth " +
      Object.entries(headerParams)
        .map(([k, v]) => oauthEncode(k) + '="' + oauthEncode(v) + '"')
        .join(", "),
    baseString,
    normalized,
    signature,
  };
}
