import { createHash, createHmac } from "node:crypto";
import { SignatureV4 } from "@smithy/signature-v4";
class SHA256 {
  constructor(secret) {
    this.hash =
      secret === undefined
        ? createHash("sha256")
        : createHmac("sha256", secret);
  }
  update(data) {
    this.hash.update(typeof data === "string" ? data : Buffer.from(data));
  }
  async digest() {
    return this.hash.digest();
  }
}
function queryMode(auth) {
  if (
    auth.addAuthDataToQuery !== undefined &&
    typeof auth.addAuthDataToQuery !== "boolean"
  )
    throw Error("AWS addAuthDataToQuery必须为布尔值");
  return auth.addAuthDataToQuery === true;
}
export async function awsSignatureHeaders(
  url,
  method,
  headers,
  body,
  auth = {},
) {
  if (queryMode(auth))
    throw Error("AWS Query认证须使用完整请求签名，不能降级为Header签名");
  for (const key of ["accessKey", "secretKey", "region", "service"])
    if (typeof auth[key] !== "string" || !auth[key].trim())
      throw Error("AWS签名缺少 " + key);
  if (!/^[a-z0-9-]+$/.test(auth.region) || !/^[a-z0-9-]+$/.test(auth.service))
    throw Error("AWS region/service格式无效");
  const target = new URL(url),
    query = Object.create(null);
  let count = 0;
  for (const [key, value] of target.searchParams) {
    if (++count > 10000) throw Error("AWS签名参数过多");
    if (Object.hasOwn(query, key))
      query[key] = Array.isArray(query[key])
        ? [...query[key], value]
        : [query[key], value];
    else query[key] = value;
  }
  const signingDate = auth.signingDate
    ? new Date(auth.signingDate)
    : new Date();
  if (!Number.isFinite(signingDate.getTime())) throw Error("AWS签名时间无效");
  const wireHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value)
        ? value
            .map((item) => String(item).trim().replace(/\s+/g, " "))
            .join(",")
        : String(value),
    ]),
  );
  wireHeaders.host ||= target.host;
  delete wireHeaders.authorization;
  delete wireHeaders["x-amz-date"];
  delete wireHeaders["x-amz-security-token"];
  wireHeaders["x-amz-content-sha256"] = createHash("sha256")
    .update(body || "")
    .digest("hex");
  const signer = new SignatureV4({
    service: auth.service,
    region: auth.region,
    sha256: SHA256,
    uriEscapePath: auth.service !== "s3",
    credentials: {
      accessKeyId: auth.accessKey,
      secretAccessKey: auth.secretKey,
      ...(auth.sessionToken ? { sessionToken: auth.sessionToken } : {}),
    },
  });
  const signed = await signer.sign(
    {
      method,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port ? Number(target.port) : undefined,
      path: target.pathname,
      query,
      headers: wireHeaders,
      body,
    },
    { signingDate },
  );
  return signed.headers;
}

const generatedQueryNames = new Set([
  "x-amz-algorithm",
  "x-amz-credential",
  "x-amz-date",
  "x-amz-expires",
  "x-amz-signedheaders",
  "x-amz-signature",
  "x-amz-security-token",
  "x-amz-content-sha256",
  "x-amz-region-set",
]);
const encodeQuery = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

// S3 signs object paths without normalization. Inspect the original string
// before WHATWG URL parsing can silently collapse dot segments/backslashes.
export function validateAWSQueryURL(url) {
  if (
    typeof url !== "string" ||
    !url.isWellFormed() ||
    url !== url.trim() ||
    /[\\\x00-\x1f\x7f]/.test(url) ||
    Buffer.byteLength(url) > 1024 * 1024
  )
    throw Error("AWS Query URL无效");
  const path = /^https?:\/\/[^/?#]*(\/[^?#]*)?/.exec(url)?.[1] || "/";
  try {
    for (const part of path.split("/")) {
      const decoded = decodeURIComponent(part);
      if ([".", ".."].includes(decoded) || encodeQuery(decoded) !== part)
        throw Error("noncanonical path");
    }
  } catch {
    throw Error("S3 Query路径须为规范RFC3986 UTF-8编码且不能包含点段");
  }
  if (new URL(url).pathname !== path)
    throw Error("S3 Query路径不能在URL解析中被改写");
}

/**
 * Complete runtime-only signing result. Header mode retains its existing path.
 * Query mode is bounded to empty-body S3 GET/HEAD; no implicit AWS credentials.
 * Callers must replace URL AND headers: presign may remove/hoist old headers.
 */
export async function awsSignatureRequest(
  url,
  method,
  headers,
  body,
  auth = {},
) {
  if (!queryMode(auth))
    return {
      url,
      headers: await awsSignatureHeaders(url, method, headers, body, auth),
    };
  if (
    auth.service !== "s3" ||
    !["GET", "HEAD"].includes(method) ||
    (body !== undefined && body !== null && Buffer.byteLength(body) !== 0)
  )
    throw Error("AWS Query认证目前仅支持S3的GET/HEAD且实际正文必须为空");
  for (const key of [
    "accessKey",
    "secretKey",
    "region",
    "service",
    "sessionToken",
  ])
    if (
      (key !== "sessionToken" || auth[key] !== undefined) &&
      (typeof auth[key] !== "string" ||
        !auth[key].isWellFormed() ||
        /[\r\n\0]/.test(auth[key]) ||
        Buffer.byteLength(auth[key]) > 65536 ||
        (key !== "sessionToken" && !auth[key].trim()))
    )
      throw Error("AWS Query认证须显式提供有效凭据、区域与服务");
  if (!/^[a-z0-9-]+$/.test(auth.region)) throw Error("AWS region格式无效");
  validateAWSQueryURL(url);
  const target = new URL(url),
    query = Object.create(null);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.hash
  )
    throw Error("AWS Query认证URL不能包含内嵌凭据或片段");
  // URLSearchParams otherwise silently replaces malformed UTF-8. Reject it
  // rather than signing and sending a different user query.
  try {
    decodeURIComponent(target.pathname);
    decodeURIComponent(target.search.replaceAll("+", " "));
  } catch {
    throw Error("AWS Query URL须使用有效UTF-8百分号编码");
  }
  let count = 0,
    expiresIn = 86400,
    expirySeen = false;
  for (const [key, value] of target.searchParams) {
    if (++count > 10000) throw Error("AWS签名参数过多");
    // Smithy 5.7.4's internal canonical serializer uses a normal object.
    if (key === "__proto__") throw Error("AWS Query不支持此参数名称");
    if (key === "X-Amz-Expires" && !expirySeen) {
      if (!/^[1-9][0-9]{0,5}$/.test(value) || Number(value) > 604800)
        throw Error("AWS Query过期时间须为1至604800秒的整数");
      expiresIn = Number(value);
      expirySeen = true;
      continue;
    }
    if (generatedQueryNames.has(key.toLowerCase()))
      throw Error("AWS Query认证控制参数重复、冲突或包含旧签名");
    if (Object.hasOwn(query, key)) {
      if (Array.isArray(query[key])) query[key].push(value);
      else query[key] = [query[key], value];
    } else query[key] = value;
  }
  const wireHeaders = Object.create(null);
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (Object.hasOwn(wireHeaders, name)) throw Error("AWS Query Header重复");
    wireHeaders[name] = Array.isArray(value)
      ? value.map((item) => String(item).trim().replace(/\s+/g, " ")).join(",")
      : String(value);
  }
  if (wireHeaders.host !== undefined && wireHeaders.host !== target.host)
    throw Error("AWS Query Host须匹配请求URL");
  wireHeaders.host = target.host;
  if (
    wireHeaders["transfer-encoding"] !== undefined ||
    (wireHeaders["content-length"] !== undefined &&
      wireHeaders["content-length"] !== "0")
  )
    throw Error("AWS Query空正文不能声明非零Content-Length或Transfer-Encoding");
  delete wireHeaders.authorization;
  delete wireHeaders["x-amz-date"];
  delete wireHeaders["x-amz-security-token"];
  const queryNames = new Set(
    Object.keys(query).map((key) => key.toLowerCase()),
  );
  for (const name of Object.keys(wireHeaders))
    if (name.startsWith("x-amz-") && name !== "x-amz-content-sha256") {
      if (generatedQueryNames.has(name) || queryNames.has(name))
        throw Error("AWS Query参数与认证/业务Header冲突");
    }
  // Drive S3's payload marker through the public API, but exclude the internal
  // sentinel from canonical headers/query and remove it from the wire below.
  // This matches AWS's published vector, not a claim of payload integrity.
  wireHeaders["x-amz-content-sha256"] = "UNSIGNED-PAYLOAD";
  const signingDate = auth.signingDate
    ? new Date(auth.signingDate)
    : new Date();
  if (!Number.isFinite(signingDate.getTime())) throw Error("AWS签名时间无效");
  const signer = new SignatureV4({
    service: "s3",
    region: auth.region,
    sha256: SHA256,
    uriEscapePath: false,
    credentials: {
      accessKeyId: auth.accessKey,
      secretAccessKey: auth.secretKey,
      ...(auth.sessionToken ? { sessionToken: auth.sessionToken } : {}),
    },
  });
  const signed = await signer.presign(
    {
      method,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port ? Number(target.port) : undefined,
      path: target.pathname,
      query,
      headers: wireHeaders,
      body,
    },
    {
      signingDate,
      expiresIn,
      unsignableHeaders: new Set(["x-amz-content-sha256"]),
      // Keep ordinary x-amz headers (including encryption headers) signed on the
      // wire. Smithy's default hoisting can overwrite user query values.
      unhoistableHeaders: new Set(
        Object.keys(wireHeaders).filter((key) => key.startsWith("x-amz-")),
      ),
    },
  );
  // Preserve the order of duplicate values. Canonical signing sorts them, but
  // that is not permission to reorder the actual user's request semantics.
  target.search = Object.entries(signed.query)
    .flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).map(
        (item) => encodeQuery(key) + "=" + encodeQuery(item),
      ),
    )
    .join("&");
  if (Buffer.byteLength(target.href) > 1024 * 1024)
    throw Error("AWS Query签名URL超过1MiB");
  delete signed.headers["x-amz-content-sha256"];
  return { url: target.href, headers: signed.headers };
}
