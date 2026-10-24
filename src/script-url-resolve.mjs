import {
  initializeQueryRuntime,
  validateQueryRuntime,
  renderQueryRuntime,
} from "./script-url-runtime.mjs";

export async function resolveSDKURLRequest(
  request,
  variables,
  functions,
  interpolate,
  existingResolve,
) {
  if (request.scriptURLMode !== "sdk")
    return existingResolve(request, variables, functions, interpolate);
  const runtime = validateQueryRuntime(
    request.scriptURLRuntime === undefined
      ? initializeQueryRuntime(request)
      : request.scriptURLRuntime,
  );
  const clone = structuredClone(request),
    mapping = [],
    variableMapping = [];
  delete clone.scriptURLRuntime;
  clone.url = "";
  clone.query = [];
  clone.path = [];
  const components = {};
  for (const key of ["protocol", "port", "hash", "host", "path", "auth"])
    if (Object.hasOwn(runtime.state.url, key))
      components[key] = structuredClone(runtime.state.url[key]);
  runtime.state.url.variable.forEach((row, index) => {
    const origin = runtime.variableOrigins[index];
    if (typeof row.value !== "string" && !origin.dynamic) return;
    clone.path.push({
      key: row.key,
      value: row.value,
      ...(origin.dynamic ? { dynamic: origin.dynamic } : {}),
    });
    variableMapping.push(index);
  });
  clone.__sdkURLComponents = components;
  runtime.state.url.query.forEach((row, index) => {
    if (row.disabled) return;
    const active = {};
    for (const key of ["key", "value"])
      if (Object.hasOwn(row, key)) active[key] = row[key];
    if (runtime.origins[index].dynamic)
      active.dynamic = structuredClone(runtime.origins[index].dynamic);
    mapping.push(index);
    clone.query.push(active);
  });
  const result = await existingResolve(
    clone,
    variables,
    functions,
    interpolate,
  );
  const resolved = result.__sdkURLComponents;
  delete result.__sdkURLComponents;
  for (const key of ["protocol", "port", "hash", "host", "path", "auth"])
    if (Object.hasOwn(resolved, key)) runtime.state.url[key] = resolved[key];
  result.path.forEach((row, index) => {
    runtime.state.url.variable[variableMapping[index]].value = row.value;
  });
  result.query.forEach((row, index) => {
    const original = runtime.state.url.query[mapping[index]];
    for (const key of ["key", "value"])
      if (Object.hasOwn(row, key)) original[key] = row[key];
  });
  for (const origin of [...runtime.origins, ...runtime.variableOrigins])
    delete origin.dynamic;
  const checked = validateQueryRuntime(runtime);
  result.url = renderQueryRuntime(checked);
  result.query = [];
  result.path = [];
  result.scriptURLRuntime = checked;
  return result;
}
