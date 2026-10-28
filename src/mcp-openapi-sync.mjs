import { importIntoProject, resolveLocalReferences } from "./core.mjs";
import { supportedOpenAPIPathItems } from "./openapi-operation-admission.mjs";
const methods = ["get", "post", "put", "patch", "delete", "head", "options"];
export function syncMCPOpenAPI(project, args) {
  const document =
    typeof args.document === "string"
      ? JSON.parse(args.document)
      : structuredClone(args.document);
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    !/^3\.(0|1)(\.|$)/.test(document.openapi || "")
  )
    throw Error("仅支持 OpenAPI 3.0 或 3.1 JSON");
  const mode = args.coverMode ?? "url_and_folder";
  if (!["url_and_folder", "url", "ignore", "both"].includes(mode))
    throw Error("不支持该同步覆盖方式；clear 尚未提供");
  const folder = args.folder ?? "";
  if (typeof folder !== "string") throw Error("folder 必须是目录路径");
  const knownFolders = [
    ...(project.folders || []),
    ...(project.requests || [])
      .filter((r) => !r.deletedAt)
      .map((r) => r.folder),
    ...(project.documents || []).map((r) => r.folder),
    ...(project.protocols || []).map((r) => r.folder),
  ].filter(Boolean);
  if (
    folder &&
    !knownFolders.some(
      (path) => path === folder || path.startsWith(folder + "/"),
    )
  )
    throw Error("目标目录不存在");
  const resolved = resolveLocalReferences(document);
  const operations = supportedOpenAPIPathItems(resolved).flatMap(
    ([url, item]) =>
      Object.keys(item)
        .filter((method) => methods.includes(method))
        .map((method) => ({ method: method.toUpperCase(), url })),
  );
  const scripts = new Map();
  if (args.apiScripts !== undefined && !Array.isArray(args.apiScripts))
    throw Error("apiScripts 必须是数组");
  for (const item of args.apiScripts || []) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.method !== "string" ||
      typeof item.url !== "string"
    )
      throw Error("脚本映射必须指定 method 和 url");
    if (
      Object.keys(item).some(
        (k) => !["method", "url", "beforeScript", "afterScript"].includes(k),
      )
    )
      throw Error("未知脚本映射字段");
    for (const key of ["beforeScript", "afterScript"])
      if (
        Object.hasOwn(item, key) &&
        (typeof item[key] !== "string" || item[key].length > 100000)
      )
        throw Error("脚本必须是最多100000字符的字符串");
    const method = item.method.toUpperCase(),
      key = method + " " + item.url;
    if (!operations.some((op) => op.method === method && op.url === item.url))
      throw Error("脚本映射未匹配 OpenAPI 操作");
    if (scripts.has(key)) throw Error("脚本映射重复");
    scripts.set(key, item);
  }
  // Conversion and component conflicts complete on a detached draft before mutation.
  const draft = structuredClone(project);
  const converted = { requests: [], environments: [], openapiComponents: {} };
  // Convert without synchronization so source operation IDs cannot collapse rows.
  const imported = importIntoProject(converted, document, { sync: false });
  draft.openapiComponents ??= {};
  for (const [category, entries] of Object.entries(
    converted.openapiComponents,
  )) {
    draft.openapiComponents[category] = {
      ...(draft.openapiComponents[category] || {}),
      ...entries,
    };
  }
  if (imported.length !== operations.length)
    throw Error("OpenAPI 操作映射不一致");
  const output = [];
  for (let index = 0; index < imported.length; index++) {
    const request = imported[index],
      operation = operations[index];
    request.folder = [folder, request.folder].filter(Boolean).join("/");
    const script = scripts.get(operation.method + " " + operation.url);
    if (script)
      for (const key of ["beforeScript", "afterScript"])
        if (Object.hasOwn(script, key)) request[key] = script[key];
    const match =
      mode === "both"
        ? -1
        : draft.requests.findIndex(
            (old) =>
              !old.deletedAt &&
              old.method === request.method &&
              old.url === request.url &&
              (mode !== "url_and_folder" ||
                (old.folder || "") === request.folder),
          );
    if (mode === "ignore" && match >= 0) continue;
    if (match >= 0) {
      request.id = draft.requests[match].id;
      draft.requests[match] = request;
    } else draft.requests.push(request);
    output.push(request);
  }
  draft.folders = [
    ...new Set([
      ...(draft.folders || []),
      ...output.map((r) => r.folder).filter(Boolean),
    ]),
  ];
  Object.assign(project, draft);
  return output;
}
