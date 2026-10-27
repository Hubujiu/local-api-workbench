import { isDeepStrictEqual } from "node:util";
import { importIntoProject } from "./core.mjs";
import {
  assertEmptyInheritanceTarget,
  prepareNativeInheritanceSource,
  resolveNativeInheritance,
  validateNativeInheritanceProject,
} from "./native-inheritance.mjs";

export function importPreservedNativeInheritance(project, source, options) {
  assertEmptyInheritanceTarget(project);
  const prepared = prepareNativeInheritanceSource(source);
  const draft = structuredClone(project);
  draft.environments = [];
  delete draft.currentEnvironmentId;
  const effective = structuredClone(draft);
  importIntoProject(effective, source, {
    ...options,
    inheritanceMode: "flatten",
  });
  importIntoProject(draft, prepared.ownDocument, {
    ...options,
    inheritanceMode: "flatten",
  });
  const bySource = new Map(
    effective.requests.map((r) => [r.sourceOperationId, r]),
  );
  for (const request of draft.requests) {
    const sourceId = request.sourceOperationId.slice("apipost:".length);
    const own = prepared.apiLayers.get(sourceId);
    if (!own) throw Error("原生继承图：导入接口缺少来源绑定");
    request.nativeInheritance = {
      sourceProjectId: prepared.graph.sourceProjectId,
      sourceId,
      authMode: own.authMode,
    };
    request.inheritAuth =
      request.inheritGlobalParameters =
      request.inheritSharedScripts =
        false;
    prepared.graph.bindings.push({
      requestId: request.id,
      sourceId,
      parentId: own.parentId,
    });
  }
  draft.settings.nativeInheritance = prepared.graph;
  validateNativeInheritanceProject(draft);
  for (const request of draft.requests) {
    const resolved = resolveNativeInheritance(draft, request);
    const expected = bySource.get(request.sourceOperationId);
    for (const key of ["auth", "headers", "query", "cookies"])
      if (!isDeepStrictEqual(resolved[key], expected?.[key]))
        throw Error("原生继承图：来源继承不能按当前转换合同保真");
  }
  Object.assign(project, draft);
  return project.requests;
}
