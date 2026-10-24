import { folderScopePaths } from "../public/folder-scopes.js";
import {
  validateGlobalParameters,
  validateFolderParameters,
  globalParameterKinds,
} from "../public/global-parameters.js";
export { validateGlobalParameters, validateFolderParameters };
export function applyGlobalParameters(project, request) {
  const result = structuredClone(request);
  if (
    request.parametersSnapshot === true ||
    request.inheritGlobalParameters === false
  )
    return result;
  const defaults = validateGlobalParameters(project.settings?.globalParameters);
  const folders = validateFolderParameters(project.settings?.folderParameters);
  const scopes = folderScopePaths(project.settings, request.folder);
  for (const kind of globalParameterKinds) {
    if (
      kind === "form" &&
      !["form-data", "urlencoded"].includes(request.bodyType)
    )
      continue;
    const own = result[kind] || [];
    const key = (name) =>
      kind === "headers" ? String(name).toLowerCase() : String(name);
    const overrides = new Set(own.map((row) => key(row.key)));
    let inherited = defaults[kind];
    for (const scope of scopes) {
      const rows = Object.hasOwn(folders, scope)
        ? folders[scope][kind] || []
        : [];
      const keys = new Set(rows.map((row) => key(row.key)));
      inherited = [
        ...inherited.filter((row) => !keys.has(key(row.key))),
        ...rows,
      ];
    }
    result[kind] = [
      ...inherited.filter((row) => row.enabled && !overrides.has(key(row.key))),
      ...own,
    ];
  }
  return result;
}
