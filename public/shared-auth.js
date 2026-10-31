import { validateAuth } from "./auth-model.js";
import { validateFolderParameters } from "./global-parameters.js";
function validateSharedAuth(auth) {
  validateAuth(auth);
  if (new TextEncoder().encode(JSON.stringify(auth)).length > 65536)
    throw Error("共享认证最多64KiB");
  for (const [key, value] of Object.entries(auth)) {
    if (key === "nativeOAuth2" && auth.type === "oauth2") continue;
    if (
      ["__proto__", "prototype", "constructor"].includes(key) ||
      !["string", "number", "boolean"].includes(typeof value)
    )
      throw Error("共享认证字段仅接受文本、数字或布尔值");
  }
}
export function validateSharedAuthSettings(settings = {}) {
  if (Object.hasOwn(settings, "globalAuth"))
    validateSharedAuth(settings.globalAuth);
  if (settings.folderAuth !== undefined) {
    const folders = settings.folderAuth;
    if (!folders || typeof folders !== "object" || Array.isArray(folders))
      throw Error("目录认证必须是对象");
    validateFolderParameters(
      Object.fromEntries(Object.keys(folders).map((name) => [name, {}])),
    );
    for (const auth of Object.values(folders)) validateSharedAuth(auth);
    if (new TextEncoder().encode(JSON.stringify(folders)).length > 262144)
      throw Error("目录认证总计最多256KiB");
  }
}
export function renameSharedAuthScopes(settings, previous, next) {
  validateSharedAuthSettings(settings);
  const folders = structuredClone(settings?.folderAuth || {});
  if (next === previous) return folders;
  if (next !== null && Object.hasOwn(folders, next))
    throw Error("目标目录认证已存在");
  const auth = Object.hasOwn(folders, previous) ? folders[previous] : undefined;
  delete folders[previous];
  if (next !== null && auth)
    Object.defineProperty(folders, next, {
      value: auth,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  validateSharedAuthSettings({ folderAuth: folders });
  return folders;
}
