// Browser-safe static contract; no interpolation, signing, coercion or I/O.
const invalid = () => Error("OAuth1 parameterPolicy 定义无效");
const names = [
  "placement",
  "includeBodyHash",
  "includeEmptyParams",
  "headerEncoding",
];
export function oauth1ParameterPolicy(auth) {
  if (!auth || typeof auth !== "object") throw invalid();
  const selected = Object.getOwnPropertyDescriptor(auth, "parameterPolicy");
  if (!selected) {
    if ("parameterPolicy" in auth) throw invalid();
    return undefined;
  }
  if (!selected.enumerable || !Object.hasOwn(selected, "value"))
    throw invalid();
  const type = Object.getOwnPropertyDescriptor(auth, "type");
  if (!type || !Object.hasOwn(type, "value") || type.value !== "oauth1")
    throw invalid();
  const value = selected.value;
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some((key) => !names.includes(key)))
    throw invalid();
  const result = {};
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw invalid();
    result[key] = descriptor.value;
  }
  if (
    !["header", "auto"].includes(result.placement) ||
    typeof result.includeBodyHash !== "boolean" ||
    typeof result.includeEmptyParams !== "boolean" ||
    !["percent", "raw"].includes(result.headerEncoding)
  )
    throw invalid();
  // Admit explicit-policy credentials before any caller can clone/spread them.
  // These checks apply only when the new policy is present; legacy shapes stay.
  if (![Object.prototype, null].includes(Object.getPrototypeOf(auth)))
    throw invalid();
  const fields = [
    "consumerKey",
    "consumerSecret",
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
  ];
  const selectedAuth = { type: "oauth1", parameterPolicy: result };
  for (const key of Reflect.ownKeys(auth)) {
    const descriptor = Object.getOwnPropertyDescriptor(auth, key);
    if (
      typeof key !== "string" ||
      !["type", "parameterPolicy", ...fields].includes(key) ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      throw invalid();
    if (key === "type" || key === "parameterPolicy") continue;
    if (
      typeof descriptor.value !== "string" ||
      !descriptor.value.isWellFormed() ||
      new TextEncoder().encode(descriptor.value).length > 65536
    )
      throw invalid();
    selectedAuth[key] = descriptor.value;
  }
  if (new TextEncoder().encode(JSON.stringify(selectedAuth)).length > 65536)
    throw invalid();
  return Object.freeze(result);
}
