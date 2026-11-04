// Strict, literal Postman OAuth1 interchange subset; no SDK coercion or I/O.
import { types } from "node:util";
import { oauth1ParameterPolicy } from "../public/oauth1-policy-model.js";
const invalid = () => Error("Postman OAuth1 定义不在受支持的字面值子集内");
const strings = new Set([
  "consumerKey",
  "consumerSecret",
  "token",
  "accessToken",
  "tokenSecret",
  "signatureMethod",
  "privateKey",
  "privateKeyPassphrase",
  "nonce",
  "timestamp",
  "realm",
  "version",
  "callback",
  "verifier",
]);
const flags = new Set([
  "addParamsToHeader",
  "includeBodyHash",
  "addEmptyParamsToSign",
  "disableHeaderEncoding",
]);
function ownData(value, array = false) {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    (array
      ? !Array.isArray(value)
      : ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  )
    throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const d = descriptors[key];
    if (
      typeof key !== "string" ||
      !Object.hasOwn(d, "value") ||
      (!d.enumerable && !(array && key === "length"))
    )
      throw invalid();
  }
  return descriptors;
}
export function importPostmanOAuth1(attributes) {
  if (!Array.isArray(attributes) || types.isProxy(attributes)) throw invalid();
  const size = Object.getOwnPropertyDescriptor(attributes, "length");
  if (!size || size.value > 32) throw invalid();
  const list = ownData(attributes, true);
  const length = list.length.value;
  if (length > 32 || Reflect.ownKeys(list).length !== length + 1)
    throw invalid();
  const values = Object.create(null);
  let bytes = 0;
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(list, String(i))) throw invalid();
    const row = ownData(list[i].value);
    if (
      Object.keys(row).some((key) => !["key", "value", "type"].includes(key)) ||
      !row.key ||
      !row.value
    )
      throw invalid();
    const key = row.key.value,
      value = row.value.value,
      type = row.type?.value;
    if (
      typeof key !== "string" ||
      Object.hasOwn(values, key) ||
      (!strings.has(key) && !flags.has(key))
    )
      throw invalid();
    if (flags.has(key)) {
      if (
        typeof value !== "boolean" ||
        (row.type && !["boolean", "any"].includes(type))
      )
        throw invalid();
    } else {
      if (
        typeof value !== "string" ||
        (row.type && !["string", "any"].includes(type)) ||
        !value.isWellFormed() ||
        value.includes("{{") ||
        value.includes("}}") ||
        (value.length && !value.trim())
      )
        throw invalid();
      bytes += Buffer.byteLength(value);
      if (bytes > 65536) throw invalid();
    }
    values[key] = value;
  }
  if (Object.hasOwn(values, "token") && Object.hasOwn(values, "accessToken"))
    throw invalid();
  if (
    !["HMAC-SHA1", "HMAC-SHA256", "RSA-SHA1"].includes(
      values.signatureMethod,
    ) ||
    !values.consumerKey ||
    (values.signatureMethod === "RSA-SHA1"
      ? !values.privateKey
      : !values.consumerSecret)
  )
    throw invalid();
  const result = { type: "oauth1" };
  for (const key of strings)
    if (Object.hasOwn(values, key))
      result[key === "token" ? "accessToken" : key] = values[key];
  result.parameterPolicy = {
    placement: values.addParamsToHeader === true ? "header" : "auto",
    includeBodyHash: values.includeBodyHash === true,
    includeEmptyParams: values.addEmptyParamsToSign === true,
    headerEncoding: values.disableHeaderEncoding === true ? "raw" : "percent",
  };
  oauth1ParameterPolicy(result);
  return result;
}
