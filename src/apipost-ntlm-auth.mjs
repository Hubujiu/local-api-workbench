const MAX_BYTES = 64 * 1024;
const names = ["username", "password", "domain", "workstation"];
function fail(field) {
  throw Error(`原生NTLM认证 ${field} 无法安全规范映射；请使用项目备份`);
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
  // This only sees validated primitive data, never supplied toJSON/accessors.
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BYTES)
    fail("size");
  return value;
}
function credentials(value) {
  const result = {};
  for (const key of names) {
    const field = Object.hasOwn(value, key) ? value[key] : "";
    if (typeof field !== "string" || Buffer.byteLength(field) > MAX_BYTES)
      fail(key);
    result[key] = field;
  }
  if (!result.username) fail("username");
  // Original native execution may split usernames only when domain resolves
  // empty. Do not render templates or guess that identity conversion here.
  if (
    (!result.domain || result.domain.includes("{{")) &&
    /[\\@]|\{\{/.test(result.username)
  )
    fail("identity");
  return result;
}
function section(value) {
  return bounded({ ...credentials(value), disableRetryRequest: false });
}
/** Canonical explicit credentials only; no signing, credentials lookup or I/O. */
export function importApipostNtlm(value) {
  const input = data(value, [...names, "disableRetryRequest"]);
  if (
    Object.hasOwn(input, "disableRetryRequest") &&
    input.disableRetryRequest !== false
  )
    fail("disableRetryRequest");
  const identity = credentials(input);
  bounded(input);
  section(identity); // Added defaults must also fit the native output cap.
  return { type: "ntlm", ...identity };
}
export function exportApipostNtlm(value) {
  const input = data(value, ["type", ...names]);
  if (input.type !== "ntlm") fail("type");
  return { type: "ntlm", ntlm: section(input) };
}
