import { isDeepStrictEqual } from "node:util";
import { importIntoProject } from "./core.mjs";
import { semanticRequest } from "./apipost-sample-export.mjs";
import {
  resolveNativeInheritance,
  validateNativeInheritanceProject,
} from "./native-inheritance.mjs";

export function applyNativeInheritanceExport(
  project,
  document,
  { id, auth, rows },
) {
  const state = validateNativeInheritanceProject(project);
  if (!state) return;
  if (
    (project.plans || []).length ||
    (project.cases || []).length ||
    (project.caseFolders || []).length
  )
    throw Error("原生继承图出口首片不支持冻结计划或用例；请使用完整项目备份");
  const authValue = (intent) =>
    intent.mode === "absent"
      ? undefined
      : intent.mode === "inherit"
        ? { type: "inherit" }
        : intent.mode === "none"
          ? { type: "noauth" }
          : auth(intent.value);
  const layer = (value) => ({
    ...(value.auth.mode === "absent" ? {} : { auth: authValue(value.auth) }),
    header: { parameter: rows(value.headers, "header") },
    query: { parameter: rows(value.query, "query") },
    cookie: { parameter: rows(value.cookies, "cookie") },
    body: { parameter: [] },
    pre_tasks: [],
    post_tasks: [],
  });
  document.global.global_param = layer(state.graph.projectLayer);
  const nodes = new Map(document.apis.map((n) => [n.target_id, n]));
  for (const folder of state.folders.values())
    nodes.get(id("f", folder.path)).request = layer(folder.layer);
  for (const request of project.requests) {
    const target = nodes.get(id("a", request.id)).request;
    const mode = request.nativeInheritance.authMode;
    if (mode === "absent") delete target.auth;
    else target.auth = authValue({ mode, value: request.auth });
  }
}
function intentGraph(project) {
  const state = validateNativeInheritanceProject(project);
  return {
    projectLayer: state.graph.projectLayer,
    folders: state.graph.folders
      .map((f) => ({ path: f.path, layer: f.layer }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}
export function verifyNativeInheritanceExport(
  project,
  document,
  sourceId = (id) => id,
  options = {},
) {
  if (!project.settings?.nativeInheritance) return;
  const check = {
    requests: [],
    environments: [],
    folders: [],
    servers: [],
    settings: {},
  };
  importIntoProject(check, document, {
    ...options,
    inheritanceMode: "preserve",
  });
  if (!isDeepStrictEqual(intentGraph(project), intentGraph(check)))
    throw Error("原生继承图出口不能保留项目或目录层意图；请使用项目备份");
  for (const request of project.requests) {
    const found = check.requests.find(
      (r) => r.sourceOperationId === "apipost:" + sourceId(request.id),
    );
    if (
      !found ||
      request.nativeInheritance.authMode !== found.nativeInheritance.authMode ||
      !isDeepStrictEqual(
        semanticRequest(resolveNativeInheritance(project, request), project),
        semanticRequest(resolveNativeInheritance(check, found), check),
      )
    )
      throw Error("原生继承图出口不能保留接口意图与有效请求；请使用项目备份");
    // Also compare own definitions, not merely the flattened result: a shadowed
    // parent/child value must remain independently editable after roundtrip.
    const own = (r, p) => {
      const copy = structuredClone(r);
      delete copy.nativeInheritance;
      return semanticRequest(copy, p);
    };
    if (!isDeepStrictEqual(own(request, project), own(found, check)))
      throw Error("原生继承图出口不能保留接口own层；请使用项目备份");
  }
}
