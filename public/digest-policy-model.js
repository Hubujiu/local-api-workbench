// Browser-safe static model validation; no signing, interpolation or I/O.
const policyAlgorithms = Object.freeze([
  "MD5",
  "MD5-sess",
  "SHA-256",
  "SHA-256-sess",
  "SHA-512-256",
  "SHA-512-256-sess",
]);
const invalidPolicy = () => Error("Digest challengePolicy 定义无效");
/** Direct helper boundary: never invokes policy accessors or coercion hooks. */
export function digestChallengePolicy(credentials) {
  if (!credentials || typeof credentials !== "object") throw invalidPolicy();
  const selected = Object.getOwnPropertyDescriptor(
    credentials,
    "challengePolicy",
  );
  if (!selected) {
    if ("challengePolicy" in credentials) throw invalidPolicy();
    return undefined;
  }
  if (!selected.enumerable || !Object.hasOwn(selected, "value"))
    throw invalidPolicy();
  const type = Object.getOwnPropertyDescriptor(credentials, "type");
  if (
    (type && (!Object.hasOwn(type, "value") || type.value !== "digest")) ||
    (!type && "type" in credentials)
  )
    throw invalidPolicy();
  const policy = selected.value;
  if (
    !policy ||
    typeof policy !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(policy))
  )
    throw invalidPolicy();
  const keys = Reflect.ownKeys(policy);
  if (
    keys.length !== 2 ||
    keys.some((key) => key !== "algorithm" && key !== "retry")
  )
    throw invalidPolicy();
  const algorithm = Object.getOwnPropertyDescriptor(policy, "algorithm");
  const retry = Object.getOwnPropertyDescriptor(policy, "retry");
  for (const descriptor of [algorithm, retry])
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw invalidPolicy();
  if (
    !policyAlgorithms.includes(algorithm.value) ||
    typeof retry.value !== "boolean"
  )
    throw invalidPolicy();
  return Object.freeze({ algorithm: algorithm.value, retry: retry.value });
}
