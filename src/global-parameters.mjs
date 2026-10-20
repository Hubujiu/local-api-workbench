import {
  validateGlobalParameters,
  globalParameterKinds,
} from "../public/global-parameters.js";
export { validateGlobalParameters };
export function applyGlobalParameters(project, request) {
  const result = structuredClone(request);
  if (
    request.parametersSnapshot === true ||
    request.inheritGlobalParameters === false
  )
    return result;
  const defaults = validateGlobalParameters(project.settings?.globalParameters);
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
    result[kind] = [
      ...defaults[kind].filter(
        (row) => row.enabled && !overrides.has(key(row.key)),
      ),
      ...own,
    ];
  }
  return result;
}
