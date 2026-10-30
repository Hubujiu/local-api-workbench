import { isDeepStrictEqual } from "node:util";
import { asapAlgorithms } from "../public/asap-auth-model.js";

const names = ["alg", "iss", "aud", "kid", "privateKey", "sub", "claims"];
function fail(field) {
  throw Error(`原生ASAP认证 ${field} 无法安全规范映射；请使用项目备份`);
}
function data(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail("definition");
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      fail("definition");
    result[key] = descriptor.value;
  }
  return result;
}
function literal(value, field, max, nonempty = true) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (nonempty && !value) ||
    value.includes("{{")
  )
    fail(field);
  return value;
}
function identifier(value, field, max) {
  literal(value, field, max);
  if (
    /[^A-Za-z0-9_.+\/-]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail(field);
  return value;
}
function canonical(value, native) {
  const ttlField = native ? "exp" : "ttlSeconds";
  const input = data(value, [...names, ttlField, ...(native ? [] : ["type"])]);
  if (!native && input.type !== "asap") fail("type");
  const alg =
    !native && (input.alg === undefined || input.alg === "")
      ? "RS256"
      : input.alg;
  if (!asapAlgorithms.includes(alg)) fail("alg");
  const iss = identifier(input.iss, "iss", 200);
  const kid = identifier(input.kid, "kid", 500);
  if (!kid.startsWith(iss + "/")) fail("kid");
  const aud = literal(input.aud, "aud", 200);
  if (!aud.trim() || aud.trim().startsWith("[")) fail("aud");
  const sub = literal(
    native && (input.sub === undefined || input.sub === "") ? iss : input.sub,
    "sub",
    500,
  );
  const rawTTL = input[ttlField];
  const ttlSeconds =
    rawTTL === undefined || rawTTL === "" ? (native ? 3600 : 60) : rawTTL;
  if (
    (typeof ttlSeconds !== "number" &&
      (typeof ttlSeconds !== "string" ||
        !/^[1-9][0-9]{0,3}$/.test(ttlSeconds) ||
        String(Number(ttlSeconds)) !== ttlSeconds)) ||
    !Number.isInteger(Number(ttlSeconds)) ||
    Number(ttlSeconds) < 1 ||
    Number(ttlSeconds) > 3600
  )
    fail(ttlField);
  const privateKey = literal(input.privateKey, "privateKey", 65536);
  if (
    Buffer.byteLength(privateKey) > 65536 ||
    !/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PRIVATE KEY-----(?:\r?\n)?$/.test(
      privateKey,
    )
  )
    fail("privateKey");
  const claims =
    input.claims === undefined || input.claims === "" ? "{}" : input.claims;
  literal(claims, "claims", 4096);
  if (Buffer.byteLength(claims) > 4096) fail("claims");
  let parsed;
  try {
    parsed = JSON.parse(claims);
  } catch {
    fail("claims");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    ["iss", "aud", "sub", "iat", "exp", "jti", "kid"].some((key) =>
      Object.hasOwn(parsed, key),
    )
  )
    fail("claims");
  return {
    type: "asap",
    alg,
    iss,
    aud,
    kid,
    privateKey,
    sub,
    claims,
    ttlSeconds,
  };
}

// Static definition conversion only: no key parsing, signing or template evaluation.
export function importApipostAsap(value) {
  return canonical(value, true);
}
export function exportApipostAsap(value) {
  const expected = canonical(value, false);
  const { type, ttlSeconds, ...rest } = expected;
  const config = { ...rest, exp: ttlSeconds };
  if (!isDeepStrictEqual(importApipostAsap(config), expected))
    fail("definition");
  return { type, asap: config };
}
