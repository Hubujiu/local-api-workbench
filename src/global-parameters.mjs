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
  const folder = Object.hasOwn(folders, request.folder || "")
    ? folders[request.folder]
    : {};
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
    const folderRows = folder[kind] || [];
    const folderKeys = new Set(folderRows.map((row) => key(row.key)));
    const inherited = [
      ...defaults[kind].filter((row) => !folderKeys.has(key(row.key))),
      ...folderRows,
    ];
    result[kind] = [
      ...inherited.filter((row) => row.enabled && !overrides.has(key(row.key))),
      ...own,
    ];
  }
  return result;
}
