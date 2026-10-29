import {
  collectionScope,
  collectionExecutionScopes,
  validateCollectionScope,
  castCollectionValue,
} from "./postman-collection-scopes.mjs";
import { selectedEnvironment } from "./environments.mjs";
export function variableName(name) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 200 ||
    ["__proto__", "prototype", "constructor"].includes(name)
  )
    throw Error("变量名无效");
  return name;
}
export function copyVariableValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
export function scopeMap(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("变量层必须是对象");
  const result = Object.create(null);
  for (const [name, item] of Object.entries(value)) {
    variableName(name);
    result[name] = copyVariableValue(item);
  }
  return result;
}
export function createScopes(variables = {}, input) {
  return {
    ...(input?.collectionId === undefined
      ? {}
      : {
          collectionId: input.collectionId,
          collection: scopeMap(input.collection || {}),
          collectionTypes: scopeMap(input.collectionTypes || {}),
        }),
    globals: scopeMap(input?.globals || {}),
    environment: scopeMap(input?.environment || variables),
    runtime: scopeMap(input?.runtime || {}),
    hidden: [...(input?.hidden || [])].map(variableName),
  };
}
export function effectiveScopes(state) {
  const result = Object.assign(
    Object.create(null),
    state.globals,
    state.collection,
    state.environment,
    state.runtime,
  );
  for (const name of state.hidden) delete result[name];
  return result;
}
export function applyLegacyVariables(state, before, after) {
  const hidden = new Set(state.hidden);
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    variableName(name);
    if (Object.hasOwn(after, name) && after[name] !== undefined) {
      if (
        !Object.hasOwn(before, name) ||
        JSON.stringify(before[name]) !== JSON.stringify(after[name])
      ) {
        state.runtime[name] = copyVariableValue(after[name]);
        hidden.delete(name);
      }
    } else if (Object.hasOwn(before, name)) {
      delete state.runtime[name];
      hidden.add(name);
    }
  }
  state.hidden = [...hidden];
}
export function scopeChanges(before, after) {
  validateCollectionScope(before, before.collectionId);
  validateCollectionScope(after, before.collectionId);
  const changes = [];
  for (const scope of [
    "globals",
    "environment",
    ...(before.collectionId ? ["collection"] : []),
  ])
    for (const name of new Set([
      ...Object.keys(before[scope]),
      ...Object.keys(after[scope]),
    ])) {
      const old = {
        exists: Object.hasOwn(before[scope], name),
        value: before[scope][name],
        ...(scope === "collection" && Object.hasOwn(before[scope], name)
          ? { type: before.collectionTypes[name] }
          : {}),
      };
      const next = {
        exists: Object.hasOwn(after[scope], name),
        value: after[scope][name],
        ...(scope === "collection" && Object.hasOwn(after[scope], name)
          ? { type: after.collectionTypes[name] }
          : {}),
      };
      if (
        old.exists !== next.exists ||
        old.type !== next.type ||
        JSON.stringify(old.value) !== JSON.stringify(next.value)
      )
        changes.push({
          scope,
          ...(scope === "collection"
            ? { collectionId: before.collectionId }
            : {}),
          name,
          before: copyVariableValue(old),
          after: copyVariableValue(next),
        });
    }
  return changes;
}
export function projectScopes(
  project,
  environmentId,
  debugValues,
  collectionId,
) {
  const environment = selectedEnvironment(project, environmentId);
  const state = createScopes(
    {},
    {
      ...collectionScope(project, collectionId),
      globals: project.globalVariables || {},
      environment: environment.variables,
    },
  );
  if (debugValues)
    applyLegacyVariables(state, effectiveScopes(state), debugValues);
  return state;
}
export async function persistScopeChanges(
  store,
  projectId,
  environmentId,
  changes,
  { signal, collectionId } = {},
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (signal?.aborted) throw Error("变量提交已取消");
    const project = await store.get(projectId);
    if (signal?.aborted) throw Error("变量提交已取消");
    const environment = selectedEnvironment(project, environmentId);
    project.globalVariables ??= {};
    const collection =
      collectionId === undefined
        ? undefined
        : project.postmanCollections?.items?.find(
            (item) => item.id === collectionId,
          );
    if (collectionId !== undefined && !collection)
      throw Error("Postman collection 提交目标不存在");
    const changeMap = (change) => {
      if (change.scope === "collection") {
        if (!collection || change.collectionId !== collectionId)
          throw Error("Postman collection 提交身份无效");
        return collection.variables;
      }
      if (change.scope === "globals") return project.globalVariables;
      if (change.scope === "environment") return environment.variables;
      throw Error("未知持久化变量层");
    };
    for (const change of changes) {
      variableName(change.name);
      const map = changeMap(change);
      if (change.scope === "collection") {
        if (
          change.before.exists &&
          collection.definitions[change.name]?.type !== change.before.type
        )
          throw Error("变量冲突：collection 类型已被其他操作修改");
        if (
          change.after.exists &&
          JSON.stringify(
            castCollectionValue(change.after.value, change.after.type),
          ) !== JSON.stringify(change.after.value)
        )
          throw Error("Postman collection 提交值类型无效");
      }
      if (
        Object.hasOwn(map, change.name) !== change.before.exists ||
        JSON.stringify(map[change.name]) !== JSON.stringify(change.before.value)
      )
        throw Error(
          "变量冲突：" + change.scope + "." + change.name + " 已被其他操作修改",
        );
    }
    for (const change of changes) {
      const map = changeMap(change);
      if (change.scope === "collection") {
        if (change.after.exists)
          collection.definitions[change.name] = {
            initialValue:
              collection.definitions[change.name]?.type === change.after.type &&
              Object.hasOwn(collection.definitions[change.name], "initialValue")
                ? copyVariableValue(
                    collection.definitions[change.name].initialValue,
                  )
                : copyVariableValue(change.after.value),
            description: collection.definitions[change.name]?.description || "",
            type: change.after.type,
          };
        else delete collection.definitions[change.name];
      }
      if (change.after.exists)
        map[change.name] = copyVariableValue(change.after.value);
      else delete map[change.name];
    }
    try {
      if (signal?.aborted) throw Error("变量提交已取消");
      await store.save(project, { signal });
      return {
        project,
        scopes: projectScopes(project, environmentId, undefined, collectionId),
      };
    } catch (error) {
      if (attempt === 4 || !/项目.*已被其他/.test(error.message)) throw error;
    }
  }
}
export const scopeRuntimeSource = [
  variableName,
  copyVariableValue,
  scopeMap,
  createScopes,
  effectiveScopes,
  applyLegacyVariables,
]
  .map((fn) => fn.toString())
  .join("\n");

export function scopedExecution(
  store,
  project,
  environmentId,
  debugValues,
  collectionId,
) {
  const selected = selectedEnvironment(project, environmentId);
  const selectedId = selected.id;
  const initial = projectScopes(project, selectedId, undefined, collectionId);
  const initialCollections = collectionExecutionScopes(project);
  const baseConfigRevision = project.configRevision ?? project.revision;
  let commits = 0;
  return {
    executionContext: {
      environment: {
        id: String(selected.id),
        name: String(selected.name || ""),
      },
    },
    collectionScopes: initialCollections,
    variableScopes: projectScopes(
      project,
      selectedId,
      debugValues,
      collectionId,
    ),
    onScopeChanges: async (changes, signal, targetCollectionId) => {
      const saved = await persistScopeChanges(
        store,
        project.id,
        selectedId,
        changes,
        { signal, collectionId: targetCollectionId },
      );
      Object.assign(project, saved.project);
      commits++;
      return saved.scopes;
    },
    receipt: () => ({
      environmentId: selectedId,
      baseConfigRevision,
      commits,
      changes: [
        ...scopeChanges(
          initial,
          projectScopes(project, selectedId, undefined, collectionId),
        ),
        ...initialCollections
          .filter((state) => state.collectionId !== collectionId)
          .flatMap((state) =>
            scopeChanges(
              { ...initial, ...state },
              { ...initial, ...collectionScope(project, state.collectionId) },
            ).filter((change) => change.scope === "collection"),
          ),
      ],
    }),
  };
}
