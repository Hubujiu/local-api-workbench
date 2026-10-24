import { createHash, randomBytes } from "node:crypto";

export function digestAuthorization(
  challenge,
  credentials,
  method,
  uri,
  body = "",
  cnonce = randomBytes(12).toString("hex"),
) {
  if (!/^Digest\s/i.test(challenge)) throw Error("服务未提供 Digest challenge");
  const fields = {};
  for (const match of challenge
    .slice(7)
    .matchAll(/([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g))
    fields[match[1].toLowerCase()] = (match[2] ?? match[3]).replace(
      /\\(.)/g,
      "$1",
    );
  const algorithm = (fields.algorithm || "MD5").toUpperCase();
  const algorithmName = {
    MD5: "md5",
    "SHA-256": "sha256",
    "SHA-512-256": "sha512-256",
  }[algorithm.replace(/-SESS$/, "")];
  if (!algorithmName || !fields.nonce) throw Error("不支持的 Digest challenge");
  const hash = (value) => createHash(algorithmName).update(value).digest("hex");
  const qops = fields.qop?.split(",").map((qop) => qop.trim());
  const qop = qops?.includes("auth")
    ? "auth"
    : qops?.includes("auth-int")
      ? "auth-int"
      : undefined;
  if (qops && !qop) throw Error("不支持的 Digest qop");
  const username = credentials.username || "",
    password = credentials.password || "",
    realm = fields.realm || "",
    nc = "00000001";
  let ha1 = hash(`${username}:${realm}:${password}`);
  if (algorithm.endsWith("-SESS"))
    ha1 = hash(`${ha1}:${fields.nonce}:${cnonce}`);
  const ha2 = hash(
    `${method}:${uri}${qop === "auth-int" ? ":" + hash(body) : ""}`,
  );
  const response = hash(
    qop
      ? `${ha1}:${fields.nonce}:${nc}:${cnonce}:${qop}:${ha2}`
      : `${ha1}:${fields.nonce}:${ha2}`,
  );
  const quote = (value) =>
    '"' +
    String(value)
      .replace(/[\r\n]/g, "")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"') +
    '"';
  const params = {
    username:
      fields.userhash === "true" ? hash(`${username}:${realm}`) : username,
    realm,
    nonce: fields.nonce,
    uri,
    response,
  };
  if (fields.opaque) params.opaque = fields.opaque;
  const values = Object.entries(params).map(
    ([name, value]) => name + "=" + quote(value),
  );
  values.push("algorithm=" + algorithm);
  if (qop) values.push("qop=" + qop, "nc=" + nc, "cnonce=" + quote(cnonce));
  else if (algorithm.endsWith("-SESS")) values.push("cnonce=" + quote(cnonce));
  if (fields.userhash === "true") values.push("userhash=true");
  return "Digest " + values.join(", ");
}
