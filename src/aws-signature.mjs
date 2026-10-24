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
export async function awsSignatureHeaders(
  url,
  method,
  headers,
  body,
  auth = {},
) {
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
