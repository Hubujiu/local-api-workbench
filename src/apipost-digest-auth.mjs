import { isDeepStrictEqual } from "node:util";
import { digestChallengePolicy } from "../public/digest-policy-model.js";

const MAX_BYTES = 64 * 1024;
const stateFields = ["realm", "nonce", "qop", "nc", "cnonce", "opaque"];
const nativeFields = [
  "username",
  "password",
  ...stateFields,
  "algorithm",
  "disableRetryRequest",
];
function fail(field) {
  throw Error(`原生Digest认证 ${field} 无法安全规范映射；请使用项目备份`);
}
function data(value, fields) {
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
      !fields.includes(key) ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.value === undefined
    )
      fail("definition");
    result[key] = descriptor.value;
  }
  return result;
}
function credentials(value) {
  const username = value.username;
  const password = Object.hasOwn(value, "password") ? value.password : "";
  if (
    typeof username !== "string" ||
    !username ||
    Buffer.byteLength(username) > MAX_BYTES
  )
    fail("username");
  if (typeof password !== "string" || Buffer.byteLength(password) > MAX_BYTES)
    fail("password");
  return { username, password };
}
function policy(value) {
  try {
    const checked = digestChallengePolicy(value);
    if (!checked) fail("challengePolicy");
    return { ...checked };
  } catch {
    // Do not attach user values or a nested parser's arbitrary error text.
    fail("challengePolicy");
  }
}
function bounded(section) {
  // Only newly constructed primitive data reaches serialization, never an input
  // object with a toJSON method or an unvalidated nested policy.
  if (Buffer.byteLength(JSON.stringify(section), "utf8") > MAX_BYTES)
    fail("size");
  return section;
}
function nativeSection(auth) {
  return bounded({
    username: auth.username,
    password: auth.password,
    realm: "",
    nonce: "",
    algorithm: auth.challengePolicy.algorithm,
    qop: "",
    nc: "",
    cnonce: "",
    opaque: "",
    disableRetryRequest: !auth.challengePolicy.retry,
  });
}

/** Pure bounded bootstrap conversion, never authentication or interpolation. */
export function importApipostDigest(value) {
  const input = data(value, nativeFields);
  const identity = credentials(input);
  for (const field of stateFields)
    if (Object.hasOwn(input, field) && input[field] !== "") fail(field);
  if (Object.hasOwn(input, "algorithm") && typeof input.algorithm !== "string")
    fail("algorithm");
  if (
    Object.hasOwn(input, "disableRetryRequest") &&
    typeof input.disableRetryRequest !== "boolean"
  )
    fail("disableRetryRequest");
  const challengePolicy = policy({
    type: "digest",
    challengePolicy: {
      algorithm: input.algorithm || "MD5",
      retry: !input.disableRetryRequest,
    },
  });
  // The selected input is now known to contain only validated primitives.
  bounded(input);
  const result = { type: "digest", ...identity, challengePolicy };
  // Defaults add fields/bytes. Every accepted import must remain exportable.
  nativeSection(result);
  return result;
}
export function exportApipostDigest(value) {
  const input = data(value, [
    "type",
    "username",
    "password",
    "challengePolicy",
  ]);
  if (input.type !== "digest") fail("type");
  const expected = {
    type: "digest",
    ...credentials(input),
    challengePolicy: policy(input),
  };
  const section = nativeSection(expected);
  if (!isDeepStrictEqual(importApipostDigest(section), expected))
    fail("definition");
  return { type: "digest", digest: section };
}
