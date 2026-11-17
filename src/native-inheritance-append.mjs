import { isDeepStrictEqual } from "node:util";
import { manualImportID } from "./manual-import-token.mjs";
import { validateNativeInheritanceProject } from "./native-inheritance.mjs";
const fail = () => {
  throw Object.assign(
    Error("原生追加要求相同来源和共享定义，且只能创建新的HTTP身份"),
    { code: "MANUAL_IMPORT_NATIVE_APPEND_CONFLICT" },
  );
};
const same = (a, b) => isDeepStrictEqual(a, b);
const layer = (value) => ({ ...value, form: value.form || [] });
// This constructor accepts only the detached, preserve-mode converter result.
// It never edits old definitions. The Store replays it against locked storage.
export function appendNativeInheritance(target, source, context) {
  const prior = validateNativeInheritanceProject(target),
    incoming = validateNativeInheritanceProject(source);
  if (
    !prior ||
    !incoming ||
    target.archived ||
    prior.graph.sourceProjectId !== incoming.graph.sourceProjectId ||
    !same(layer(prior.graph.projectLayer), layer(incoming.graph.projectLayer))
  )
    fail();
  for (const key of [
    "environments",
    "servers",
    "globalVariables",
    "globalVariableDefinitions",
  ])
    if (!same(target[key], source[key])) fail();
  for (const key of ["plans", "cases", "documents", "dictionary", "protocols"])
    if (source[key]?.length) fail();
  const settings = { ...source.settings };
  delete settings.nativeInheritance;
  for (const [key, value] of Object.entries(settings))
    if (!same(value, target.settings?.[key])) fail();
  if (
    Object.values(source.openapiComponents || {}).some(
      (value) => Object.keys(value).length,
    )
  )
    fail();
  const next = structuredClone(target),
    graph = next.settings.nativeInheritance;
  const occupied = new Set([
    ...prior.graph.folders.map((f) => f.sourceId),
    ...prior.graph.bindings.map((b) => b.sourceId),
  ]);
  const ids = new Set(
    [
      "requests",
      "documents",
      "protocols",
      "plans",
      "cases",
      "environments",
      "dictionary",
      "caseFolders",
      "modelFolders",
    ].flatMap((key) => (target[key] || []).map((v) => v.id)),
  );
  for (const entry of target.requestDefinitionHistory?.entries || [])
    ids.add(entry.requestId);
  const items = [];
  for (const folder of incoming.graph.folders) {
    const old = prior.graph.folders.find((f) => f.sourceId === folder.sourceId);
    if (old) {
      if (
        prior.inactiveFolders.has(old.sourceId) ||
        !same(
          { ...old, layer: layer(old.layer) },
          { ...folder, layer: layer(folder.layer) },
        )
      )
        fail();
      items.push({
        key: "folder:" + incoming.graph.folders.indexOf(folder),
        kind: "folder",
        action: "reuse",
        targetFolder: old.path,
        dependencies: [],
      });
    } else {
      if (
        occupied.has(folder.sourceId) ||
        (target.folders || []).includes(folder.path) ||
        prior.graph.folders.some((f) => f.path === folder.path)
      )
        fail();
      graph.folders.push(structuredClone(folder));
      next.folders.push(folder.path);
      occupied.add(folder.sourceId);
      items.push({
        key: "folder:" + incoming.graph.folders.indexOf(folder),
        kind: "folder",
        action: "create",
        targetFolder: folder.path,
        dependencies: [],
      });
    }
  }
  for (const binding of incoming.graph.bindings) {
    if (occupied.has(binding.sourceId)) fail();
    const request = source.requests.find((r) => r.id === binding.requestId);
    if (!request || request.deletedAt) fail();
    const id = manualImportID(context, "native-api:" + binding.sourceId);
    if (ids.has(id)) fail();
    ids.add(id);
    occupied.add(binding.sourceId);
    next.requests.push({ ...structuredClone(request), id });
    graph.bindings.push({ ...binding, requestId: id });
    items.push({
      key: "api:" + incoming.graph.bindings.indexOf(binding),
      kind: "api",
      action: "create",
      targetId: id,
      dependencies: [],
    });
  }
  validateNativeInheritanceProject(next);
  return {
    project: next,
    items,
    counts: {
      created: items.filter((i) => i.action === "create").length,
      reused: items.filter((i) => i.action === "reuse").length,
      updated: 0,
      skipped: 0,
      trashed: 0,
    },
    noOp: same(next, target),
    blockers: [],
    warnings: [],
    evidence: { source, items },
    nativeAppend: { source, context },
  };
}
export function assertNativeAppendInput(input) {
  if (
    input.selection.mode !== "all" ||
    Object.keys(input.folderMap).length ||
    Object.keys(input.bindings).length ||
    input.clearScope ||
    Object.entries(input.policies).some(
      ([key, value]) => value !== (key === "globals" ? "safe" : "both"),
    ) ||
    Object.keys(input.options).length
  )
    fail();
}
