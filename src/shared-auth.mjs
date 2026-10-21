import { folderScopePaths } from "../public/folder-scopes.js";
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
  let inherited = project.settings?.globalAuth;
  for (const scope of folderScopePaths(project.settings, request.folder))
    if (Object.hasOwn(folders, scope)) inherited = folders[scope];
  if (inherited) result.auth = structuredClone(inherited);
  return result;
}
