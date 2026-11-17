export const jwtAlgorithms = [
  "HS256",
  "HS384",
  "HS512",
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
];
export function importJwtConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("JWT 导入配置必须为对象");
  const keys = new Set([
    "algorithm",
    "secret",
    "isSecretBase64Encoded",
    "payload",
    "headerPrefix",
    "queryParamKey",
    "header",
    "addTokenTo",
  ]);
  for (const [key, item] of Object.entries(value)) {
    if (!keys.has(key)) throw Error("JWT 导入不支持字段 " + key);
    if (key === "isSecretBase64Encoded") {
      if (![true, false, "true", "false"].includes(item))
        throw Error("JWT Base64 标识无效");
    } else if (typeof item !== "string")
      throw Error("JWT 导入字段必须为字符串 " + key);
  }
  if (value.algorithm && !jwtAlgorithms.includes(value.algorithm))
    throw Error("JWT 导入算法不支持");
  if (value.addTokenTo && !["header", "queryParam"].includes(value.addTokenTo))
    throw Error("JWT 导入发送位置不支持");
  return { ...structuredClone(value), type: "jwt" };
}
