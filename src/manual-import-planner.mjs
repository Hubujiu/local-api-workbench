import { isDeepStrictEqual } from "node:util";
import { manualImportID } from "./manual-import-token.mjs";
import { normalizeManualImportInput } from "./manual-import-input.mjs";
import { collectManualImportModelReferences } from "./manual-import-source.mjs";
import {
  activeAPIFolders,
  deleteAPIResources,
  validateAPIResourceTrash,
} from "./api-resource-lifecycle.mjs";
import { validateCaseFolders } from "../public/case-folders.js";
import { validateModelFolders } from "../public/model-folders.js";

const at = (value, path) => path.reduce((item, key) => item?.[key], value);
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const copy = (value) => structuredClone(value);
const pointer = (part) =>
  String(part).replaceAll("~", "~0").replaceAll("/", "~1");
const within = (path, root) =>
  root === "" || path === root || path.startsWith(root + "/");
const fail = (code = "MANUAL_IMPORT_PLAN_INVALID") => {
  throw Object.assign(Error("手动导入计划无法安全应用；请重新检查选择与冲突"), {
    code,
  });
};
function put(value, path, item) {
  let parent = value;
  for (const key of path.slice(0, -1)) {
    if (!own(parent, key))
      Object.defineProperty(parent, key, {
        value: {},
        enumerable: true,
        writable: true,
        configurable: true,
      });
    parent = parent[key];
    if (!object(parent) && !Array.isArray(parent)) fail();
  }
  Object.defineProperty(parent, path.at(-1), {
    value: item,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

// Conservative metadata union, never a blanket settings overwrite. Exact equal
// values reuse; keyed lists add new identities; collisions remain conflicts.
function safeMerge(previous, incoming, path = []) {
  if (previous === undefined) return copy(incoming);
  if (isDeepStrictEqual(previous, incoming)) return copy(previous);
  if (Array.isArray(previous) && Array.isArray(incoming)) {
    const result = copy(previous);
    for (const item of incoming) {
      if (result.some((old) => isDeepStrictEqual(old, item))) continue;
      const key =
        object(item) &&
        (path[0] === "settings" && path[1] === "functions"
          ? ["name"]
          : ["id", "key"]
        ).find((field) => typeof item[field] === "string");
      if (key && result.some((old) => old?.[key] === item[key]))
        fail("MANUAL_IMPORT_RESOURCE_CONFLICT");
      result.push(copy(item));
    }
    return result;
  }
  if (object(previous) && object(incoming)) {
    const registry =
      ["globalVariables", "globalVariableDefinitions"].includes(path[0]) ||
      (path[0] === "openapiComponents" && path.length === 2) ||
      (path[0] === "settings" &&
        [
          "folderAuth",
          "folderScripts",
          "folderParameters",
          "folderServices",
        ].includes(path[1]));
    const collections = path.length === 1 && path[0] === "postmanCollections";
    if (!registry && !collections) fail("MANUAL_IMPORT_RESOURCE_CONFLICT");
    const result = copy(previous);
    for (const [key, value] of Object.entries(incoming)) {
      if (own(previous, key) && !isDeepStrictEqual(previous[key], value)) {
        if (collections && key === "items")
          put(result, [key], safeMerge(previous[key], value, [...path, key]));
        else fail("MANUAL_IMPORT_RESOURCE_CONFLICT");
      } else if (!own(previous, key)) put(result, [key], copy(value));
    }
    return result;
  }
  fail("MANUAL_IMPORT_RESOURCE_CONFLICT");
}

const primaryArrays = Object.freeze({
  api: "requests",
  document: "documents",
  case: "cases",
  "case-folder": "caseFolders",
  "model-folder": "modelFolders",
  environment: "environments",
});
const priorities = {
  folder: 0,
  api: 1,
  "model-folder": 2,
  model: 3,
  environment: 4,
  "case-folder": 5,
  case: 6,
};

/** Pure business plan. Store metadata/history is deliberately not generated here. */
export function buildManualImportPlan(
  target,
  graph,
  rawInput,
  context,
  { modelReferences } = {},
) {
  const input = normalizeManualImportInput(rawInput);
  if (target.archived || target.settings?.nativeInheritance !== undefined)
    fail("MANUAL_IMPORT_TARGET_UNSUPPORTED");
  validateAPIResourceTrash(target);
  const nodes = graph.nodes;
  if (
    !Array.isArray(nodes) ||
    nodes.length > 5000 ||
    new Set(nodes.map((node) => node.key)).size !== nodes.length
  )
    fail();
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const requested = new Set(
    input.selection.mode === "all"
      ? nodes.map((node) => node.key)
      : input.selection.keys,
  );
  const excluded = new Set(input.selection.exclude || []);
  for (const key of [...requested, ...excluded, ...Object.keys(input.bindings)])
    if (!byKey.has(key)) fail("MANUAL_IMPORT_SELECTION_INVALID");
  const selected = new Set();
  function expand(key, destination) {
    if (destination.has(key)) return;
    if (excluded.has(key)) fail("MANUAL_IMPORT_DEPENDENCY_EXCLUDED");
    const node = byKey.get(key);
    if (!node) fail("MANUAL_IMPORT_DEPENDENCY_MISSING");
    destination.add(key);
    for (const dependency of node.dependencies) expand(dependency, destination);
  }
  for (const key of requested) expand(key, selected);
  for (const key of Object.keys(input.bindings))
    if (!selected.has(key)) fail("MANUAL_IMPORT_SELECTION_INVALID");

  const items = new Map(
    nodes.map((node) => [
      node.key,
      {
        key: node.key,
        kind: node.kind,
        action: "skip",
        reason: "not_selected",
        dependencies: [...node.dependencies],
      },
    ]),
  );
  const blockers = [],
    warnings = [];
  const block = (node, reason) => {
    const item = items.get(node.key);
    item.action = "block";
    item.reason = reason;
    blockers.push({ key: node.key, code: reason });
  };
  const knownFolders = new Set(activeAPIFolders(target));
  const sourceFolders = new Set(
    nodes.filter((node) => node.kind === "folder").map((node) => node.id),
  );
  for (const source of Object.keys(input.folderMap))
    if (source !== "" && !sourceFolders.has(source))
      fail("MANUAL_IMPORT_FOLDER_MAP_INVALID");
  const scope = input.clearScope?.folder;
  if (scope && !knownFolders.has(scope))
    fail("MANUAL_IMPORT_CLEAR_SCOPE_INVALID");
  const folderTargets = new Map();
  function mapFolder(source) {
    if (folderTargets.has(source)) return folderTargets.get(source);
    const parts = (source || "").split("/");
    for (let length = parts.length; length >= 0; length--) {
      const prefix = parts.slice(0, length).join("/");
      if (own(input.folderMap, prefix)) {
        const destination = [input.folderMap[prefix], ...parts.slice(length)]
          .filter(Boolean)
          .join("/");
        folderTargets.set(source, destination);
        return destination;
      }
    }
    folderTargets.set(source, source || "");
    return source || "";
  }
  const assignments = new Map(),
    claimed = new Map();
  const allOccupied = new Set([
    ...Object.keys(primaryArrays).flatMap((kind) =>
      (target[primaryArrays[kind]] || []).map((entry) => entry.id),
    ),
    ...(target.dictionary || []).map((entry) => entry.id),
    ...Object.keys(target.openapiComponents?.schemas || {}),
    ...(target.protocols || []).map((entry) => entry.id),
    ...(target.plans || []).map((entry) => entry.id),
    ...(target.requestDefinitionHistory?.entries || []).map(
      (entry) => entry.requestId,
    ),
  ]);
  const selectedOrder = nodes
    .filter((node) => selected.has(node.key))
    .sort((a, b) => {
      const rank = (priorities[a.kind] ?? 7) - (priorities[b.kind] ?? 7);
      if (rank) return rank;
      if (a.kind === "folder")
        return a.id.split("/").length - b.id.split("/").length;
      const depth = (node) => {
        let count = 0,
          current = node,
          seen = new Set();
        while (current && !seen.has(current.key)) {
          seen.add(current.key);
          current = current.dependencies
            .map((key) => byKey.get(key))
            .find((parent) => parent.kind === node.kind);
          if (current) count++;
        }
        return count;
      };
      return depth(a) - depth(b);
    });
  const mappedReference = (node, kind) => {
    const reference = node.references.find((ref) => ref.kind === kind);
    return reference
      ? (assignments.get(reference.targetKey) ?? reference.targetId)
      : "";
  };
  const recordAssignment = (node, destination, existing = false) => {
    const collision = claimed.get(destination);
    if (collision && collision !== node.key) {
      block(node, "multiple_sources_one_target");
      return false;
    }
    if (!existing && allOccupied.has(destination)) {
      block(node, "identity_collision");
      return false;
    }
    assignments.set(node.key, destination);
    claimed.set(destination, node.key);
    items.get(node.key).targetId = destination;
    return true;
  };

  for (const node of selectedOrder) {
    const item = items.get(node.key);
    delete item.reason;
    const value = node.value;
    const binding = input.bindings[node.key];
    // Service/environment bindings for a live API cannot yet be remapped
    // losslessly by selective import. Refuse the selected plan bundle rather
    // than create a plan that can point at the wrong service or fail later.
    if (
      node.kind === "plan-bundle" &&
      node.references.some(
        (ref) =>
          ref.kind === "api" && !ref.key && ref.path.at(-1) === "liveRequestId",
      )
    ) {
      block(node, "live_plan_import_unsupported");
      continue;
    }
    if (node.kind === "folder") {
      const destination = mapFolder(node.id);
      if (!destination) {
        block(node, "folder_cannot_be_root");
        continue;
      }
      if (scope !== undefined && !within(destination, scope)) {
        block(node, "outside_clear_scope");
        continue;
      }
      const boundAncestor =
        !requested.has(node.key) &&
        nodes.some(
          (api) =>
            api.kind === "api" &&
            selected.has(api.key) &&
            !requested.has(api.key) &&
            input.bindings[api.key] &&
            within(api.value.folder || "", node.id) &&
            (target.requests || []).some(
              (old) =>
                old.id === input.bindings[api.key] &&
                !old.deletedAt &&
                within(old.folder || "", destination),
            ),
        );
      if (
        input.policies.api === "both" &&
        knownFolders.has(destination) &&
        !boundAncestor
      ) {
        block(node, "both_folder_requires_new_path");
        continue;
      }
      if (
        [...assignments].some(
          ([key, path]) =>
            byKey.get(key)?.kind === "folder" && path === destination,
        )
      ) {
        block(node, "folder_mapping_collision");
        continue;
      }
      assignments.set(node.key, destination);
      item.targetFolder = destination;
      item.action = knownFolders.has(destination) ? "reuse" : "create";
      continue;
    }
    if (node.kind === "api") {
      const destinationFolder = mapFolder(value.folder || "");
      item.targetFolder = destinationFolder;
      if (scope !== undefined && !within(destinationFolder, scope)) {
        block(node, "outside_clear_scope");
        continue;
      }
      const mode = input.policies.api;
      const matching = (target.requests || []).filter(
        (old) =>
          !old.deletedAt &&
          old.method === value.method &&
          old.url === value.url &&
          (mode !== "url_and_folder" ||
            (old.folder || "") === destinationFolder),
      );
      if (binding && !requested.has(node.key)) {
        const old = (target.requests || []).find(
          (request) => request.id === binding && !request.deletedAt,
        );
        if (!old || scope !== undefined) {
          block(node, "invalid_dependency_binding");
          continue;
        }
        if (recordAssignment(node, old.id, true)) {
          item.action = "reuse";
          item.reason = "explicit_dependency_binding";
        }
        continue;
      }
      const candidates = binding
        ? matching.filter((old) => old.id === binding)
        : matching;
      if (
        binding &&
        (["both", "clear"].includes(mode) || candidates.length !== 1)
      ) {
        block(node, "invalid_target_binding");
        continue;
      }
      if (!["both", "clear"].includes(mode) && candidates.length > 1) {
        block(node, "ambiguous_api_match");
        continue;
      }
      if (mode === "ignore" && candidates.length) {
        item.action = "skip";
        item.reason = "existing_method_url";
        continue;
      }
      const old = ["url", "url_and_folder"].includes(mode)
        ? candidates[0]
        : undefined;
      if (
        recordAssignment(
          node,
          old?.id ?? manualImportID(context, node.key),
          Boolean(old),
        )
      )
        item.action = old ? "update" : "create";
      continue;
    }
    if (node.kind === "case" || node.kind === "case-folder") {
      const api = node.references.find((ref) => ref.kind === "api");
      if (api && ["skip", "block"].includes(items.get(api.targetKey)?.action)) {
        item.action = "skip";
        item.reason = "skipped_api_dependency";
        continue;
      }
      const sourceRequestId = mappedReference(node, "api");
      const parentKind = "case-folder";
      const parentId = mappedReference(node, parentKind);
      const list = target[node.kind === "case" ? "cases" : "caseFolders"] || [];
      const matches =
        input.policies.samples === "name"
          ? list.filter(
              (old) =>
                old.name === value.name &&
                old.sourceRequestId === sourceRequestId &&
                (old[node.kind === "case" ? "folderId" : "parentId"] || "") ===
                  parentId,
            )
          : [];
      const candidates = binding
        ? matches.filter((old) => old.id === binding)
        : matches;
      if (candidates.length > 1 || (binding && candidates.length !== 1)) {
        block(node, "ambiguous_sample_match");
        continue;
      }
      if (
        recordAssignment(
          node,
          candidates[0]?.id ?? manualImportID(context, node.key),
          Boolean(candidates[0]),
        )
      )
        item.action = candidates.length ? "update" : "create";
      continue;
    }
    if (node.kind === "model" || node.kind === "model-folder") {
      const list =
        node.kind === "model"
          ? target.dictionary || []
          : target.modelFolders || [];
      const parentId = mappedReference(node, "model-folder");
      const matches =
        input.policies.models === "name"
          ? list.filter(
              (old) =>
                old.name === value.name &&
                (node.kind === "model" || (old.parentId || "") === parentId),
            )
          : [];
      const candidates = binding
        ? matches.filter((old) => old.id === binding)
        : matches;
      if (candidates.length > 1 || (binding && candidates.length !== 1)) {
        block(node, "ambiguous_model_match");
        continue;
      }
      if (
        node.kind === "model" &&
        input.options.modelNameMode === "preserve" &&
        input.policies.models === "both" &&
        list.some((old) => old.name === value.name)
      ) {
        block(node, "preserved_model_name_conflict");
        continue;
      }
      if (
        recordAssignment(
          node,
          candidates[0]?.id ?? manualImportID(context, node.key),
          Boolean(candidates[0]),
        )
      )
        item.action = candidates.length ? "update" : "create";
      continue;
    }
    if (node.kind === "document" || node.kind === "environment") {
      if (binding) {
        block(node, "unsupported_binding");
        continue;
      }
      if (node.kind === "document") {
        item.targetFolder = mapFolder(value.folder || "");
        if (scope !== undefined && !within(item.targetFolder, scope)) {
          block(node, "outside_clear_scope");
          continue;
        }
      }
      if (recordAssignment(node, manualImportID(context, node.key)))
        item.action = "create";
      continue;
    }
    if (binding) {
      block(node, "unsupported_bundle_binding");
      continue;
    }
    if (
      ![
        "globals",
        "protocol-bundle",
        "plan-bundle",
        "collection-bundle",
        "artifacts",
      ].includes(node.kind)
    ) {
      block(node, "unsupported_resource_kind");
      continue;
    }
    item.action = "create";
  }

  // Dependencies of ignored roots do not accidentally mutate global metadata.
  const needed = new Set();
  function need(key) {
    if (needed.has(key) || ["skip", "block"].includes(items.get(key)?.action))
      return;
    needed.add(key);
    for (const dependency of byKey.get(key).dependencies) need(dependency);
  }
  for (const key of requested) need(key);
  for (const node of selectedOrder) {
    const item = items.get(node.key);
    if (!needed.has(node.key) && item.action !== "block") {
      item.action = "skip";
      item.reason ??= "unused_dependency";
    }
  }
  for (const node of selectedOrder) {
    if (!needed.has(node.key)) continue;
    for (const dependency of node.dependencies)
      if (!needed.has(dependency))
        block(node, "unavailable_required_dependency");
  }
  const source = copy(graph.project);
  const rewrittenPath = (path) => {
    if (path[0] === "openapiComponents" && path[1] === "schemas") {
      const model = nodes.find(
        (node) => node.kind === "model" && node.id === path[2],
      );
      if (model && assignments.has(model.key))
        return [
          ...path.slice(0, 2),
          assignments.get(model.key),
          ...path.slice(3),
        ];
    }
    return path;
  };
  // Rewrite references before moving component object keys, so every original
  // source path still addresses its proven schema position.
  for (const node of selectedOrder) {
    if (!needed.has(node.key)) continue;
    for (const ref of node.references) {
      // Non-schema component keys are atomic globals; their full pointer is stable.
      if (ref.kind === "component") continue;
      const destination = assignments.get(ref.targetKey) ?? ref.targetId;
      if (destination === undefined) {
        block(node, "unmapped_reference");
        continue;
      }
      if (ref.key) {
        const parent = at(source, ref.path.slice(0, -1)),
          old = ref.path.at(-1);
        if (destination !== old && own(parent, destination)) {
          block(node, "reference_key_collision");
          continue;
        }
        const value = parent[old];
        delete parent[old];
        put(parent, [destination], value);
      } else
        put(
          source,
          ref.path,
          ref.kind === "schema"
            ? `#/components/schemas/${pointer(destination)}${ref.suffix || ""}`
            : destination,
        );
    }
    for (const identity of node.identities) {
      if (identity.id !== node.id || !assignments.has(node.key) || identity.key)
        continue;
      put(source, identity.path, assignments.get(node.key));
    }
    if (node.kind === "api" || node.kind === "document")
      put(
        source,
        [...node.paths[0], "folder"],
        items.get(node.key).targetFolder,
      );
  }
  for (const node of selectedOrder)
    if (node.kind === "model" && needed.has(node.key)) {
      const destination = assignments.get(node.key);
      const schemas = source.openapiComponents?.schemas;
      if (schemas && own(schemas, node.id) && destination !== node.id) {
        if (own(schemas, destination)) {
          block(node, "component_key_collision");
          continue;
        }
        const schema = schemas[node.id];
        delete schemas[node.id];
        put(schemas, [destination], schema);
      }
    }

  let next = copy(target);
  const trashItems = [],
    folderShells = [];
  if (scope !== undefined) {
    const existing = [
      ...(target.requests || []),
      ...(target.documents || []),
    ].filter((entry) => !entry.deletedAt && within(entry.folder || "", scope));
    const deleting = new Set(existing.map((entry) => entry.id));
    for (const [key, id] of assignments)
      if (deleting.has(id))
        block(byKey.get(key), "clear_target_binding_intersection");
    if (
      ![...needed].some((key) =>
        ["api", "document"].includes(byKey.get(key).kind),
      )
    )
      fail("MANUAL_IMPORT_CLEAR_SELECTION_EMPTY");
    if (existing.length && !blockers.length) {
      try {
        next = deleteAPIResources(
          next,
          existing.map((entry) => entry.id),
          {
            deletedAt: new Date(context.issuedAt).toISOString(),
            batchId: manualImportID(context, "trash:clear"),
          },
        ).project;
        for (const entry of existing)
          trashItems.push({
            key: `clear:${entry.id}`,
            kind: (target.requests || []).some(
              (request) => request.id === entry.id,
            )
              ? "api"
              : "document",
            action: "trash",
            targetId: entry.id,
            dependencies: [],
          });
        for (const path of knownFolders)
          if (within(path, scope) && !(next.folders || []).includes(path)) {
            next.folders ??= [];
            next.folders.push(path);
            folderShells.push(path);
          }
      } catch {
        blockers.push({
          key: "clear",
          code: "clear_recovery_capacity_or_identity",
        });
      }
    }
    warnings.push({
      code: "clear_keeps_folders_and_frozen_evidence_not_whole_import_undo",
    });
  }
  const updatedTargetOwners = new Set(
    [...items.values()]
      .filter((item) => item.action === "update")
      .map((item) => `${item.kind}:${item.targetId}`),
  );
  for (const node of selectedOrder) {
    if (!needed.has(node.key)) continue;
    const item = items.get(node.key);
    if (node.kind === "model" && item.action === "update") {
      const schemaPath = node.paths.find(
        (path) => path[0] === "openapiComponents",
      );
      if (!schemaPath) {
        block(node, "model_schema_missing");
        continue;
      }
      const newSchema = at(source, rewrittenPath(schemaPath));
      const oldSchema = target.openapiComponents?.schemas?.[item.targetId];
      if (
        !isDeepStrictEqual(newSchema, oldSchema) &&
        (modelReferences ??= collectManualImportModelReferences(target)).some(
          (ref) =>
            ref.modelId === item.targetId &&
            !updatedTargetOwners.has(`${ref.ownerKind}:${ref.ownerId}`),
        )
      ) {
        block(node, "unselected_model_consumer");
        continue;
      }
    }
    if (
      item.action === "reuse" &&
      item.reason === "explicit_dependency_binding"
    )
      continue;
    try {
      if (node.kind === "folder") {
        next.folders ??= [];
        if (!next.folders.includes(item.targetFolder))
          next.folders.push(item.targetFolder);
      } else if (own(primaryArrays, node.kind)) {
        const field = primaryArrays[node.kind],
          value = copy(at(source, node.paths[0]));
        next[field] ??= [];
        const index = next[field].findIndex(
          (entry) => entry.id === item.targetId,
        );
        if (item.action === "update" && index >= 0) {
          if (isDeepStrictEqual(next[field][index], value))
            item.action = "reuse";
          else next[field][index] = value;
        } else if (index < 0) next[field].push(value);
        else block(node, "identity_collision");
      } else if (node.kind === "model") {
        for (const path of node.paths) {
          const mapped = rewrittenPath(path),
            value = copy(at(source, mapped));
          if (path[0] === "dictionary") {
            next.dictionary ??= [];
            const index = next.dictionary.findIndex(
              (entry) => entry.id === item.targetId,
            );
            if (index < 0) next.dictionary.push(value);
            else next.dictionary[index] = value;
          } else put(next, mapped, value);
        }
      } else {
        let changed = false;
        for (const path of node.paths) {
          const previous = at(next, path),
            incoming = at(source, path);
          const merged = safeMerge(previous, incoming, path);
          changed ||= !isDeepStrictEqual(previous, merged);
          put(next, path, merged);
        }
        item.action = changed ? "create" : "reuse";
      }
    } catch {
      block(node, "resource_conflict");
    }
  }
  if (!blockers.length) {
    validateCaseFolders(next);
    validateModelFolders(next);
    validateAPIResourceTrash(next);
  }
  const resultItems = [...items.values(), ...trashItems];
  for (const folder of folderShells)
    resultItems.push({
      key: `clear-shell:${folder}`,
      kind: "folder",
      action: "create",
      targetFolder: folder,
      reason: "preserve_existing_implicit_shell",
      dependencies: [],
    });
  const counts = { created: 0, updated: 0, reused: 0, skipped: 0, trashed: 0 };
  for (const item of resultItems) {
    const key = {
      create: "created",
      update: "updated",
      reuse: "reused",
      skip: "skipped",
      trash: "trashed",
    }[item.action];
    if (key) counts[key]++;
  }
  const noOp = !blockers.length && isDeepStrictEqual(next, target);
  return {
    project: blockers.length ? copy(target) : next,
    items: resultItems,
    counts,
    noOp,
    blockers,
    warnings,
    evidence: { source, items: resultItems, folderShells },
  };
}
