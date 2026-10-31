import { nativeOAuth2Definition } from "./native-oauth2-model.js";
export const authTypes = [
  "none",
  "bearer",
  "basic",
  "digest",
  "ntlm",
  "oauth1",
  "oauth2",
  "aws",
  "hawk",
  "edgegrid",
  "apiKey",
  "jwt",
  "asap",
];
export function validateAuth(auth = {}) {
  nativeOAuth2Definition(auth);
  if (!auth || typeof auth !== "object" || Array.isArray(auth))
    throw Error("认证配置必须为对象");
  if (auth.type !== undefined && !authTypes.includes(auth.type))
    throw Error("不支持的认证类型: " + String(auth.type));
}
