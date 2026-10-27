import {
  variableRows,
  updateVariable,
} from "../public/variable-definitions.js";
import { applySharedScripts } from "./shared-scripts.mjs";
import { applySharedAuth } from "./shared-auth.mjs";
import { applyGlobalParameters } from "./global-parameters.mjs";
import { randomUUID } from "node:crypto";
function name(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw Error("名称不能为空且最多200字符");
  return value.trim();
}
function address(value) {
  if (value === "") return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("服务地址必须是 HTTP/HTTPS URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("服务地址必须是无内嵌凭据的 HTTP/HTTPS URL");
  return String(value).replace(/\/$/, "");
}
function key(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    ["__proto__", "prototype", "constructor"].includes(value)
  )
    throw Error("变量名无效");
  return value;
}
export function selectedEnvironment(project, environmentId) {
  const environments = project.environments || [];
  const selected =
    environmentId || project.currentEnvironmentId || environments[0]?.id;
  const env = environments.find((e) => e.id === selected);
  if (!env) throw Error("环境不存在");
  return env;
}
export function environmentVariables(project, environmentId) {
  const env = selectedEnvironment(project, environmentId);
  return { ...(project.globalVariables || {}), ...(env.variables || {}) };
}
export function effectiveServiceId(project, request) {
  if (request.serviceId) return request.serviceId;
  if (
    request.serviceSnapshot ||
    /^(?:https?:\/\/|\{\{)/i.test(String(request.url || ""))
  )
    return "";
  return project.settings?.folderServices?.[request.folder] || "";
}
export function freezeServiceBinding(
  project,
  request,
  { includeSharedScripts = true } = {},
) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw Error("接口定义必须是对象");
  return {
    ...applySharedAuth(
      project,
      applyGlobalParameters(
        project,
        includeSharedScripts ? applySharedScripts(project, request) : request,
      ),
    ),
    sharedScriptsSnapshot: true,
    authSnapshot: true,
    parametersSnapshot: true,
    serviceId: effectiveServiceId(project, request),
    serviceSnapshot: true,
  };
}
export function resolveServiceRequest(project, request, environmentId) {
  const serviceId = effectiveServiceId(project, request);
  if (!serviceId) return request;
  const env = selectedEnvironment(project, environmentId);
  const server = (project.servers || []).find((s) => s.id === serviceId);
  if (!server) throw Error("服务不存在");
  const base = env.serverUrls?.[server.id];
  if (!base) throw Error("当前环境未配置服务地址");
  if (/^https?:\/\//i.test(request.url))
    throw Error("绑定服务的接口 URL 必须为相对路径");
  if (String(request.url).startsWith("//"))
    throw Error("接口路径不能覆盖服务主机");
  return {
    ...request,
    serviceId,
    url:
      base.replace(/\/$/, "") +
      "/" +
      String(request.url || "").replace(/^\//, ""),
  };
}
// Scope commits refresh the caller's project object. Keep routing configuration
// private and detached for this execution without snapshotting variable values.
export function createServiceRequestResolver(project, environmentId) {
  const selected = selectedEnvironment(project, environmentId);
  const selectedId = selected.id;
  const context = {
    environments: [
      {
        id: selectedId,
        serverUrls: { ...(selected.serverUrls || {}) },
      },
    ],
    servers: (project.servers || []).map(({ id }) => ({ id })),
    settings: {
      folderServices: { ...(project.settings?.folderServices || {}) },
    },
  };
  return (request) => resolveServiceRequest(context, request, selectedId);
}
export function manageEnvironment(project, operation, args = {}) {
  project.environments ??= [];
  project.servers ??= [];
  project.globalVariables ??= {};
  let env;
  if (
    operation.includes("environment") &&
    ![
      "create_environment",
      "list_environments",
      "delete_environment_server",
    ].includes(operation)
  )
    env = selectedEnvironment(project, args.environmentId);
  switch (operation) {
    case "list_environments":
      return {
        currentEnvironmentId:
          project.currentEnvironmentId || project.environments[0]?.id,
        environments: structuredClone(project.environments),
      };
    case "switch_environment":
      project.currentEnvironmentId = env.id;
      return structuredClone(env);
    case "create_environment": {
      const item = {
        id: randomUUID(),
        name: name(args.name),
        variables: {},
        serverUrls: {},
      };
      if (args.baseUrl !== undefined)
        item.variables.baseUrl = address(args.baseUrl);
      project.environments.push(item);
      project.currentEnvironmentId ??= item.id;
      return structuredClone(item);
    }
    case "update_environment":
      if (args.name !== undefined) env.name = name(args.name);
      if (args.baseUrl !== undefined)
        (env.variables ??= {}).baseUrl = address(args.baseUrl);
      return structuredClone(env);
    case "delete_environment":
      if (project.environments.length <= 1) throw Error("至少保留一个环境");
      project.environments = project.environments.filter(
        (e) => e.id !== env.id,
      );
      if (project.currentEnvironmentId === env.id)
        project.currentEnvironmentId = project.environments[0].id;
      for (const plan of project.plans || [])
        if (plan.environmentId === env.id)
          plan.environmentId =
            project.currentEnvironmentId || project.environments[0].id;
      return { deletedId: env.id };
    case "list_environment_servers":
      return {
        environmentId: env.id,
        servers: project.servers.map((server) => ({
          ...server,
          url: env.serverUrls?.[server.id] || "",
        })),
      };
    case "create_environment_server": {
      const server = { id: randomUUID(), name: name(args.name) },
        url = address(args.url);
      project.servers.push(server);
      (env.serverUrls ??= {})[server.id] = url;
      return { ...server, url, environmentId: env.id };
    }
    case "update_environment_server": {
      const server = project.servers.find((s) => s.id === args.serverId);
      if (!server) throw Error("服务不存在");
      if (args.name !== undefined) server.name = name(args.name);
      if (args.url !== undefined)
        (env.serverUrls ??= {})[server.id] = address(args.url);
      return {
        ...server,
        url: env.serverUrls?.[server.id] || "",
        environmentId: env.id,
      };
    }
    case "delete_environment_server": {
      if (!project.servers.some((s) => s.id === args.serverId))
        throw Error("服务不存在");
      project.servers = project.servers.filter((s) => s.id !== args.serverId);
      for (const e of project.environments)
        if (e.serverUrls) delete e.serverUrls[args.serverId];
      return { deletedId: args.serverId };
    }
    case "get_environment_variables":
      return {
        environmentId: env.id,
        variables: structuredClone(env.variables || {}),
        definitions: structuredClone(env.variableDefinitions || {}),
        entries: variableRows(
          env.variables || {},
          env.variableDefinitions || {},
        ),
        effectiveVariables: environmentVariables(project, env.id),
      };
    case "get_global_variables":
      return {
        variables: structuredClone(project.globalVariables),
        definitions: structuredClone(project.globalVariableDefinitions || {}),
        entries: variableRows(
          project.globalVariables,
          project.globalVariableDefinitions || {},
        ),
      };
    case "upsert_environment_variable":
    case "upsert_global_variable": {
      const global = operation.includes("global");
      const updated = updateVariable(
        global ? project.globalVariables : env.variables || {},
        global
          ? project.globalVariableDefinitions || {}
          : env.variableDefinitions || {},
        args,
      );
      if (global) {
        project.globalVariables = updated.values;
        project.globalVariableDefinitions = updated.definitions;
      } else {
        env.variables = updated.values;
        env.variableDefinitions = updated.definitions;
      }
      return { ...updated.variable, value: updated.variable.currentValue };
    }

    case "delete_environment_variable":
    case "delete_global_variable": {
      const map = operation.includes("global")
          ? project.globalVariables
          : (env.variables ??= {}),
        variable = key(args.key);
      const definitions = operation.includes("global")
        ? project.globalVariableDefinitions
        : env.variableDefinitions;
      const existed =
        Object.hasOwn(map, variable) ||
        Boolean(definitions && Object.hasOwn(definitions, variable));
      delete map[variable];
      if (definitions) delete definitions[variable];
      return { key: variable, deleted: existed };
    }
    default:
      throw Error("未知环境操作");
  }
}

export function debugEnvironment(project, environmentId, cache) {
  const environment = selectedEnvironment(project, environmentId);
  const persisted = environmentVariables(project, environment.id);
  const fingerprint = JSON.stringify(persisted);
  const cacheKey = project.id + ":" + environment.id;
  const entry = cache.get(cacheKey);
  return {
    environment,
    cacheKey,
    fingerprint,
    variables: structuredClone(
      entry?.fingerprint === fingerprint ? entry.variables : persisted,
    ),
  };
}

export function validateEnvironmentModel(project) {
  const bindings = project.settings?.folderServices || {};
  if (
    typeof bindings !== "object" ||
    Array.isArray(bindings) ||
    Object.keys(bindings).length > 1000
  )
    throw Error("目录服务绑定必须为最多1000项的映射");
  for (const [folder, service] of Object.entries(bindings)) {
    key(folder);
    if (typeof service !== "string" || !service || service.length > 200)
      throw Error("目录服务标识无效");
  }

  function variables(map) {
    if (!map || typeof map !== "object" || Array.isArray(map))
      throw Error("变量必须是JSON对象");
    if (Object.keys(map).length > 10000) throw Error("变量数量超过限制");
    for (const variable of Object.keys(map)) key(variable);
  }
  if (project.globalVariables !== undefined) variables(project.globalVariables);
  if (project.globalVariableDefinitions !== undefined)
    variableRows(
      project.globalVariables || {},
      project.globalVariableDefinitions,
    );
  if (
    !Array.isArray(project.environments) ||
    project.environments.length === 0 ||
    project.environments.length > 200
  )
    throw Error("项目必须有1至200个环境");
  const ids = new Set();
  for (const env of project.environments) {
    if (!env || typeof env.id !== "string" || ids.has(env.id))
      throw Error("环境ID无效或重复");
    ids.add(env.id);
    name(env.name);
    variables(env.variables);
    if (env.variableDefinitions !== undefined)
      variableRows(env.variables, env.variableDefinitions);
    if (env.serverUrls !== undefined) {
      if (
        !env.serverUrls ||
        typeof env.serverUrls !== "object" ||
        Array.isArray(env.serverUrls)
      )
        throw Error("服务地址映射无效");
      for (const [id, url] of Object.entries(env.serverUrls)) {
        key(id);
        address(url);
      }
    }
  }
  if (project.currentEnvironmentId && !ids.has(project.currentEnvironmentId))
    throw Error("当前环境不存在");
  if (project.servers !== undefined) {
    if (!Array.isArray(project.servers) || project.servers.length > 100)
      throw Error("共享服务最多100个");
    const seen = new Set();
    for (const server of project.servers) {
      key(server.id);
      name(server.name);
      if (seen.has(server.id)) throw Error("服务ID重复");
      seen.add(server.id);
    }
  }
}
