// Independent peer-side RFC5849 verification. No production auth helper imports.
import assert from "node:assert/strict";
import { createHash, createHmac, verify, constants } from "node:crypto";
const encode = (value) =>
  encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
export function verifyOAuth1Policy({
  url,
  method,
  headers,
  body,
  auth,
  bodyType,
  publicKey,
}) {
  const target = new URL(url),
    policy = auth.parameterPolicy;
  const form = bodyType === "urlencoded",
    placement =
      !policy || policy.placement === "header"
        ? "header"
        : form && ["POST", "PUT"].includes(method)
          ? "form"
          : "query";
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
  const query = [...target.searchParams],
    formPairs = form ? [...new URLSearchParams(bytes.toString())] : [];
  let protocol;
  if (placement === "header") {
    assert(headers.authorization?.startsWith("OAuth "));
    const rawHeader = headers.authorization.slice(6);
    const matched = [...rawHeader.matchAll(/(?:^|, )([a-zA-Z_]+)="([^"]*)"/g)];
    assert.equal(
      matched.map((match) => match[0]).join(""),
      rawHeader,
      "entire OAuth header must parse",
    );
    const fields = matched.map((m) => [
      decodeURIComponent(m[1]),
      policy?.headerEncoding === "raw" ? m[2] : decodeURIComponent(m[2]),
    ]);
    assert(fields.length > 0);
    assert.equal(new Set(fields.map(([k]) => k)).size, fields.length);
    protocol = Object.fromEntries(fields);
    assert.equal(query.filter(([k]) => k.startsWith("oauth_")).length, 0);
    assert.equal(formPairs.filter(([k]) => k.startsWith("oauth_")).length, 0);
    if (auth.realm) assert.equal(protocol.realm, auth.realm);
    else assert(!Object.hasOwn(protocol, "realm"));
  } else {
    assert.equal(headers.authorization, undefined);
    const selected = placement === "form" ? formPairs : query;
    const values = selected.filter(([k]) => k.startsWith("oauth_"));
    assert.equal(new Set(values.map(([k]) => k)).size, values.length);
    protocol = Object.fromEntries(values);
    assert.equal(
      (placement === "form" ? query : formPairs).filter(([k]) =>
        k.startsWith("oauth_"),
      ).length,
      0,
    );
    assert(!Object.hasOwn(protocol, "realm"));
  }
  const signatureMethod = auth.signatureMethod || "HMAC-SHA1";
  assert.equal(protocol.oauth_consumer_key, auth.consumerKey);
  assert.equal(protocol.oauth_signature_method, signatureMethod);
  if (auth.nonce) assert.equal(protocol.oauth_nonce, auth.nonce);
  else assert.match(protocol.oauth_nonce, /^[a-f0-9]{32}$/);
  if (auth.timestamp)
    assert.equal(protocol.oauth_timestamp, String(auth.timestamp));
  else assert.match(protocol.oauth_timestamp, /^[1-9]\d*$/);
  for (const [field, name] of [
    ["accessToken", "oauth_token"],
    ["version", "oauth_version"],
  ]) {
    if (auth[field] || policy?.includeEmptyParams)
      assert.equal(protocol[name], auth[field] || "");
    else assert(!Object.hasOwn(protocol, name));
  }
  for (const [field, name] of [
    ["callback", "oauth_callback"],
    ["verifier", "oauth_verifier"],
  ]) {
    if (auth[field]) assert.equal(protocol[name], auth[field]);
    else assert(!Object.hasOwn(protocol, name));
  }
  if (policy?.includeBodyHash && !form)
    assert.equal(
      protocol.oauth_body_hash,
      createHash(signatureMethod === "HMAC-SHA256" ? "sha256" : "sha1")
        .update(bytes)
        .digest("base64"),
    );
  else assert(!Object.hasOwn(protocol, "oauth_body_hash"));
  const expectedKeys = [
    "oauth_consumer_key",
    "oauth_nonce",
    "oauth_signature_method",
    "oauth_timestamp",
    "oauth_signature",
  ];
  if (auth.accessToken || policy?.includeEmptyParams)
    expectedKeys.push("oauth_token");
  if (auth.version || policy?.includeEmptyParams)
    expectedKeys.push("oauth_version");
  if (auth.callback) expectedKeys.push("oauth_callback");
  if (auth.verifier) expectedKeys.push("oauth_verifier");
  if (policy?.includeBodyHash && !form) expectedKeys.push("oauth_body_hash");
  if (placement === "header" && auth.realm) expectedKeys.push("realm");
  assert.deepEqual(Object.keys(protocol).sort(), expectedKeys.sort());
  const pairs = [...query, ...formPairs].filter(
    ([k]) => k !== "oauth_signature",
  );
  if (placement === "header")
    pairs.push(
      ...Object.entries(protocol).filter(
        ([k]) => k !== "realm" && k !== "oauth_signature",
      ),
    );
  const normalized = pairs
    .map(([k, v]) => [encode(k), encode(v)])
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
  const authority = headers.host
    ? new URL(target.protocol + "//" + headers.host).host
    : target.host;
  const base = [
    method,
    target.protocol + "//" + authority + target.pathname,
    normalized,
  ]
    .map(encode)
    .join("&");
  if (signatureMethod === "RSA-SHA1")
    assert(
      verify(
        "RSA-SHA1",
        Buffer.from(base),
        { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(protocol.oauth_signature, "base64"),
      ),
    );
  else
    assert.equal(
      protocol.oauth_signature,
      createHmac(
        signatureMethod === "HMAC-SHA256" ? "sha256" : "sha1",
        encode(auth.consumerSecret || "") +
          "&" +
          encode(auth.tokenSecret || ""),
      )
        .update(base)
        .digest("base64"),
    );
  return {
    placement,
    protocol,
    normalized,
    base,
    ordinaryQuery: query.filter(([k]) => !k.startsWith("oauth_")),
    ordinaryForm: formPairs.filter(([k]) => !k.startsWith("oauth_")),
  };
}
