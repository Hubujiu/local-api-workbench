import { validateHeaderName } from "node:http";
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function section(auth, name, keys) {
  if (!object(auth) || Buffer.byteLength(JSON.stringify(auth), "utf8") > 65536)
    throw Error("Apipost认证配置必须为最多64KiB的对象");
  const value = auth[name];
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw Error("Apipost认证包含未知字段或无效配置");
  return value;
}
function strings(value, names) {
  const result = {};
  for (const name of names) {
    if (value[name] !== undefined && typeof value[name] !== "string")
      throw Error("Apipost认证字段必须为字符串: " + name);
    result[name] = value[name] ?? "";
  }
  return result;
}
/** Pure format conversion only. Never obtains tokens or makes network requests. */
export function importExtendedApipostAuth(auth) {
  if (auth?.type === "kv") {
    const value = section(auth, "kv", ["in", "key", "value"]);
    const result = strings(value, ["in", "key", "value"]);
    if (
      !["header", "query"].includes(result.in) ||
      !result.key ||
      /[\r\n\0]/.test(result.key)
    )
      throw Error("Apipost私密键值对位置或名称无效");
    if (result.in === "header" && !result.key.includes("{{"))
      validateHeaderName(result.key);
    return {
      type: "apiKey",
      ...result,
      ...(result.in === "query" ? { queryEncoding: "apipost" } : {}),
    };
  }
  if (auth?.type === "awsv4") {
    const names = [
      "accessKey",
      "secretKey",
      "sessionToken",
      "region",
      "service",
    ];
    const value = section(auth, "awsv4", [...names, "addAuthDataToQuery"]);
    if (
      value.addAuthDataToQuery !== undefined &&
      value.addAuthDataToQuery !== false
    )
      throw Error("Apipost AWS Query预签名尚未支持，不能替换为Header签名");
    return { type: "aws", ...strings(value, names) };
  }
  if (auth?.type === "hawk") {
    const names = [
      "algorithm",
      "app",
      "authId",
      "authKey",
      "delegation",
      "extraData",
      "nonce",
      "timestamp",
      "user",
    ];
    const value = section(auth, "hawk", [...names, "includePayloadHash"]);
    const fields = strings(value, names);
    if (!["sha1", "sha256"].includes(fields.algorithm) || fields.user)
      throw Error("Apipost Hawk算法或user扩展尚未支持");
    if (
      value.includePayloadHash !== undefined &&
      typeof value.includePayloadHash !== "boolean"
    )
      throw Error("Apipost Hawk载荷散列开关必须为布尔值");
    return {
      type: "hawk",
      algorithm: fields.algorithm,
      id: fields.authId,
      key: fields.authKey,
      app: fields.app,
      dlg: fields.delegation,
      ext: fields.extraData,
      nonce: fields.nonce,
      timestamp: fields.timestamp,
      payloadHash: value.includePayloadHash === true ? "enabled" : "disabled",
    };
  }
  if (auth?.type === "edgegrid") {
    const names = [
      "accessToken",
      "baseURi",
      "clientSecret",
      "clientToken",
      "headersToSign",
      "nonce",
      "timestamp",
    ];
    const fields = strings(section(auth, "edgegrid", names), names);
    const { baseURi, ...rest } = fields;
    return { type: "edgegrid", ...rest, baseURL: baseURi };
  }
  return undefined;
}
