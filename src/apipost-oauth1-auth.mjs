import { isDeepStrictEqual } from "node:util";
import { oauth1ParameterPolicy } from "../public/oauth1-policy-model.js";
const MAX_BYTES = 65536;
const methods = ["HMAC-SHA1", "HMAC-SHA256", "RSA-SHA1"];
const flags = [
  "addEmptyParamsToSign",
  "includeBodyHash",
  "addParamsToHeader",
  "disableHeaderEncoding",
];
const textFields = [
  "consumerKey",
  "consumerSecret",
  "accessToken",
  "tokenSecret",
  "signatureMethod",
  "realm",
  "version",
  "nonce",
  "timestamp",
  "callback",
  "verifier",
  "privateKey",
  "privateKeyPassphrase",
];
const nativeFields = textFields
  .filter((key) => key !== "privateKeyPassphrase")
  .map((key) => (key === "accessToken" ? "token" : key));
function fail(field) {
  throw Error(`原生OAuth1认证 ${field} 无法安全规范映射；请使用项目备份`);
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
function bounded(value) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BYTES)
    fail("size");
  return value;
}
function identity(input, native) {
  const result = {};
  for (const field of textFields) {
    const source = native && field === "accessToken" ? "token" : field,
      value =
        native && field === "privateKeyPassphrase"
          ? ""
          : Object.hasOwn(input, source)
            ? input[source]
            : "";
    if (typeof value !== "string") fail("definition");
    result[field] = value;
  }
  if (!result.consumerKey) fail("consumerKey");
  if (!native && !result.signatureMethod) result.signatureMethod = "HMAC-SHA1";
  if (!methods.includes(result.signatureMethod)) fail("signatureMethod");
  if (!["", "1.0"].includes(result.version)) fail("version");
  if (result.privateKeyPassphrase !== "") fail("privateKeyPassphrase");
  return result;
}
function validated(auth) {
  try {
    const policy = oauth1ParameterPolicy(auth);
    if (!policy) fail("parameterPolicy");
    return { ...auth, parameterPolicy: { ...policy } };
  } catch {
    fail("parameterPolicy");
  }
}
function nativeSection(auth) {
  const result = {};
  for (const field of nativeFields)
    result[field] = auth[field === "token" ? "accessToken" : field];
  return bounded({
    ...result,
    addEmptyParamsToSign: auth.parameterPolicy.includeEmptyParams,
    includeBodyHash: auth.parameterPolicy.includeBodyHash,
    addParamsToHeader: auth.parameterPolicy.placement === "header",
    disableHeaderEncoding: auth.parameterPolicy.headerEncoding === "raw",
  });
}
/** Definition conversion only. Never resolves templates, obtains credentials or signs. */
export function importApipostOAuth1(value) {
  const input = data(value, [...nativeFields, ...flags]);
  for (const field of flags)
    if (!Object.hasOwn(input, field) || typeof input[field] !== "boolean")
      fail(field);
  const credentials = identity(input, true);
  bounded(input);
  const result = validated({
    type: "oauth1",
    ...credentials,
    parameterPolicy: {
      placement: input.addParamsToHeader ? "header" : "auto",
      includeBodyHash: input.includeBodyHash,
      includeEmptyParams: input.addEmptyParamsToSign,
      headerEncoding: input.disableHeaderEncoding ? "raw" : "percent",
    },
  });
  nativeSection(result);
  return result;
}
export function exportApipostOAuth1(value) {
  const input = data(value, ["type", ...textFields, "parameterPolicy"]);
  if (input.type !== "oauth1") fail("definition");
  const result = validated({
    type: "oauth1",
    ...identity(input, false),
    parameterPolicy: input.parameterPolicy,
  });
  const section = nativeSection(result);
  if (!isDeepStrictEqual(importApipostOAuth1(section), result))
    fail("definition");
  return { type: "oauth1", oauth1: section };
}
