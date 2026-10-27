import { createHash, randomBytes } from "node:crypto";

// RFC 9110 §§5.6, 11: commas separate both challenges and auth-params.
// Split only outside quoted strings, then distinguish a parameter by its '='.
// Bounds also apply to direct callers, independent of Node's HTTP header limit.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PARAM = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*=[ \t]*(.*)$/;
const malformed = () => Error("无效或歧义的 Digest 认证 challenge");
function challenges(value) {
  if (value === undefined || value === null) return [];
  const lines = Array.isArray(value) ? value : [value];
  if (lines.length > 64 || lines.some((line) => typeof line !== "string"))
    throw malformed();
  if (lines.reduce((size, line) => size + line.length + 1, 0) > 16384)
    throw Error("Digest 认证 challenge 超出限制");
  const input = lines.join(","),
    segments = [];
  let quoted = false,
    escaped = false,
    start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i],
      code = input.charCodeAt(i);
    if ((code < 32 && code !== 9) || code === 127 || code > 255)
      throw malformed();
    if (escaped) escaped = false;
    else if (quoted && ch === "\\") escaped = true;
    else if (ch === '\"') quoted = !quoted;
    else if (!quoted && ch === ",") {
      segments.push(input.slice(start, i));
      start = i + 1;
      if (segments.length > 512) throw malformed();
    }
  }
  if (quoted || escaped) throw malformed();
  segments.push(input.slice(start));
  const result = [];
  let current;
  const addParameter = (text) => {
    const match = PARAM.exec(text);
    if (!current || current.token68 !== undefined || !match) throw malformed();
    const key = match[1].toLowerCase(),
      raw = match[2];
    let decoded = raw;
    if (raw.startsWith('"')) {
      if (!raw.endsWith('"') || raw.length < 2) throw malformed();
      decoded = "";
      for (let i = 1; i < raw.length - 1; i++) {
        let ch = raw[i];
        if (ch === "\\") {
          if (++i >= raw.length - 1) throw malformed();
          ch = raw[i];
        } else if (ch === '"') throw malformed();
        decoded += ch;
      }
    } else if (!TOKEN.test(raw)) throw malformed();
    if (Object.hasOwn(current.fields, key)) current.invalid = true;
    current.fields[key] = decoded;
    if (++current.count > 64) throw malformed();
  };
  for (const segment of segments) {
    const text = segment.replace(/^[ \t]+|[ \t]+$/g, "");
    if (!text) continue; // RFC 9110 #rule: reasonable empty members are allowed.
    if (PARAM.test(text)) {
      addParameter(text);
      continue;
    }
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?: +(.+))?$/.exec(text);
    if (!match) throw malformed();
    current = {
      scheme: match[1].toLowerCase(),
      fields: Object.create(null),
      count: 0,
    };
    result.push(current);
    if (result.length > 64) throw malformed();
    const rest = match[2];
    if (rest === undefined) continue;
    if (/^[A-Za-z0-9._~+/-]+=*$/.test(rest)) current.token68 = rest;
    else addParameter(rest);
  }
  return result;
}
function selectChallenge(value) {
  let hasDigest = false;
  for (const challenge of challenges(value)) {
    if (challenge.scheme !== "digest") continue;
    hasDigest = true;
    const fields = challenge.fields;
    // Never downgrade an ambiguous/malformed preferred Digest offer.
    if (challenge.invalid || challenge.token68 !== undefined) throw malformed();
    const algorithm = (fields.algorithm ?? "MD5").toUpperCase();
    if (!TOKEN.test(algorithm)) throw malformed();
    const algorithmName = {
      MD5: "md5",
      "SHA-256": "sha256",
      "SHA-512-256": "sha512-256",
    }[algorithm.replace(/-SESS$/, "")];
    // RFC 7616 §3.7: first supported challenge in server preference order.
    if (!algorithmName) continue;
    if (!Object.hasOwn(fields, "realm") || !fields.nonce) throw malformed();
    const qops = fields.qop
      ?.split(",")
      .map((qop) => qop.replace(/^[ \t]+|[ \t]+$/g, ""));
    if (
      qops &&
      (!qops.some(Boolean) || qops.some((qop) => qop && !TOKEN.test(qop)))
    )
      throw malformed();
    const qop = qops?.includes("auth")
      ? "auth"
      : qops?.includes("auth-int")
        ? "auth-int"
        : undefined;
    if (qops && !qop) continue;
    return { fields, algorithm, algorithmName, qop };
  }
  if (hasDigest) throw Error("不支持的 Digest challenge 或 qop");
  return null;
}

export function digestAuthorization(
  challenge,
  credentials,
  method,
  uri,
  body = "",
  cnonce = randomBytes(12).toString("hex"),
) {
  const selected = selectChallenge(challenge);
  if (!selected) return null;
  const { fields, algorithm, algorithmName, qop } = selected;
  const hash = (value) => createHash(algorithmName).update(value).digest("hex");
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
  if (fields.opaque !== undefined) params.opaque = fields.opaque;
  const values = Object.entries(params).map(
    ([name, value]) => name + "=" + quote(value),
  );
  values.push("algorithm=" + algorithm);
  if (qop) values.push("qop=" + qop, "nc=" + nc, "cnonce=" + quote(cnonce));
  else if (algorithm.endsWith("-SESS")) values.push("cnonce=" + quote(cnonce));
  if (fields.userhash === "true") values.push("userhash=true");
  return "Digest " + values.join(", ");
}
