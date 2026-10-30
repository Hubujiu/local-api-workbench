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
  const changes = [];
  for (const scope of ["globals", "environment"])
    for (const name of new Set([
      ...Object.keys(before[scope]),
      ...Object.keys(after[scope]),
    ])) {
      const old = {
        exists: Object.hasOwn(before[scope], name),
        value: before[scope][name],
      };
      const next = {
        exists: Object.hasOwn(after[scope], name),
        value: after[scope][name],
      };
      if (
        old.exists !== next.exists ||
        JSON.stringify(old.value) !== JSON.stringify(next.value)
      )
        changes.push({
          scope,
          name,
          before: copyVariableValue(old),
          after: copyVariableValue(next),
        });
    }
  return changes;
}
export function projectScopes(project, environmentId, debugValues) {
  const environment = selectedEnvironment(project, environmentId);
  const state = createScopes(
    {},
    {
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
  { signal } = {},
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (signal?.aborted) throw Error("变量提交已取消");
    const project = await store.get(projectId);
    if (signal?.aborted) throw Error("变量提交已取消");
    const environment = selectedEnvironment(project, environmentId);
    project.globalVariables ??= {};
    for (const change of changes) {
      variableName(change.name);
      if (!["globals", "environment"].includes(change.scope))
        throw Error("未知持久化变量层");
      const map =
        change.scope === "globals"
          ? project.globalVariables
          : environment.variables;
      if (
        Object.hasOwn(map, change.name) !== change.before.exists ||
        JSON.stringify(map[change.name]) !== JSON.stringify(change.before.value)
      )
        throw Error(
          "变量冲突：" + change.scope + "." + change.name + " 已被其他操作修改",
        );
    }
    for (const change of changes) {
      const map =
        change.scope === "globals"
          ? project.globalVariables
          : environment.variables;
      if (change.after.exists)
        map[change.name] = copyVariableValue(change.after.value);
      else delete map[change.name];
    }
    try {
      if (signal?.aborted) throw Error("变量提交已取消");
      await store.save(project, { signal });
      return { project, scopes: projectScopes(project, environmentId) };
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

export function scopedExecution(store, project, environmentId, debugValues) {
  const selected = selectedEnvironment(project, environmentId);
  const selectedId = selected.id;
  const initial = projectScopes(project, selectedId);
  const baseConfigRevision = project.configRevision ?? project.revision;
  let commits = 0;
  return {
    executionContext: {
      environment: {
        id: String(selected.id),
        name: String(selected.name || ""),
      },
    },
    variableScopes: projectScopes(project, selectedId, debugValues),
    onScopeChanges: async (changes, signal) => {
      const saved = await persistScopeChanges(
        store,
        project.id,
        selectedId,
        changes,
        { signal },
      );
      Object.assign(project, saved.project);
      commits++;
      return saved.scopes;
    },
    receipt: () => ({
      environmentId: selectedId,
      baseConfigRevision,
      commits,
      changes: scopeChanges(initial, projectScopes(project, selectedId)),
    }),
  };
}
