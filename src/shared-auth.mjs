import { validateSharedAuthSettings } from "../public/shared-auth.js";
export { validateSharedAuthSettings } from "../public/shared-auth.js";
export function applySharedAuth(project, request) {
  const result = structuredClone(request);
  if (
    request.authSnapshot === true ||
    request.inheritAuth === false ||
    (request.auth?.type && request.auth.type !== "none")
  )
    return result;
  validateSharedAuthSettings(project.settings);
  const folders = project.settings?.folderAuth || {};
  const inherited = Object.hasOwn(folders, request.folder || "")
    ? folders[request.folder]
    : project.settings?.globalAuth;
  if (inherited) result.auth = structuredClone(inherited);
  return result;
}
