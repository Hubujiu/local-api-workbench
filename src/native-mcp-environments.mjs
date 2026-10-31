import { randomUUID } from "node:crypto";
import {
  selectedEnvironment,
  validateEnvironmentModel,
} from "./environments.mjs";
import {
  variableRows,
  updateVariable,
} from "../public/variable-definitions.js";
const str = { type: "string" },
  any = {},
  project = { project_id: str },
  confirm = { type: "boolean", const: true };
const operations = [
  ["list_environments", {}, [], false],
  ["switch_environment", { environment_id: str }, ["environment_id"], true],
  ["create_environment", { name: str, base_url: str }, ["name"], true],
  [
    "update_environment",
    { environment_id: str, name: str, base_url: str },
    ["environment_id"],
    true,
  ],
  [
    "delete_environment",
    { environment_id: str, confirm },
    ["environment_id", "confirm"],
    true,
  ],
  ["list_environment_servers", { environment_id: str }, [], false],
  [
    "create_environment_server",
    { name: str, environment_id: str, base_url: str },
    ["name"],
    true,
  ],
  [
    "update_environment_server",
    { server_id: str, name: str, environment_id: str, base_url: str },
    ["server_id"],
    true,
  ],
  [
    "delete_environment_server",
    { server_id: str, confirm },
    ["server_id", "confirm"],
    true,
  ],
  [
    "get_environment_variables",
    { environment_id: str },
    ["environment_id"],
    false,
  ],
  [
    "upsert_environment_variable",
    {
      environment_id: str,
      key: str,
      value: any,
      current_value: any,
      description: str,
    },
    ["environment_id", "key"],
    true,
  ],
  [
    "delete_environment_variable",
    { environment_id: str, key: str, confirm },
    ["environment_id", "key", "confirm"],
    true,
  ],
  ["get_global_variables", {}, [], false],
  [
    "upsert_global_variable",
    { key: str, value: any, current_value: any, description: str },
    ["key"],
    true,
  ],
  ["delete_global_variable", { key: str, confirm }, ["key", "confirm"], true],
];
const own = (o, k) => Object.hasOwn(o, k);
const textName = (value) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200)
    throw Error("名称不能为空且最多200字符");
  return value.trim();
};
const address = (value) => {
  if (value === "") return "";
  if (typeof value !== "string" || value.length > 65536)
    throw Error("服务地址无效");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("服务地址须为无凭据/Query/片段的HTTP地址");
  return value.replace(/\/$/, "");
};
function defaults(p) {
  return (
    p.nativeMCPDefaults || {
      version: 1,
      environmentId:
        p.environments.find((e) => e.id === "1")?.id || p.environments[0].id,
      serverId:
        p.servers?.find((s) => s.id === "1")?.id || p.servers?.[0]?.id || "1",
    }
  );
}
export function ensureNativeDefaults(p) {
  const d = defaults(p);
  p.servers ??= [];
  if (!p.servers.some((s) => s.id === d.serverId))
    p.servers.push({ id: d.serverId, name: "默认服务" });
  for (const e of p.environments) (e.serverUrls ??= {})[d.serverId] ??= "";
  p.nativeMCPDefaults = { ...d };
  p.currentEnvironmentId ??= d.environmentId;
  return d;
}
export function resolveNativeEnvironment(p, id) {
  if (typeof id !== "string" || !id.trim() || id.length > 200)
    throw Error("环境ID不能为空且最多200字符");
  validateEnvironmentModel(p);
  const exact = p.environments.find((e) => e.id === id);
  if (exact) return exact;
  if (id === "1") return selectedEnvironment(p, defaults(p).environmentId);
  throw Error("环境不存在");
}
const environment = resolveNativeEnvironment;

function service(p, id) {
  const result =
    p.servers?.find((s) => s.id === id) ||
    (id === "1"
      ? p.servers?.find((s) => s.id === defaults(p).serverId)
      : undefined);
  if (!result) throw Error("服务不存在");
  return result;
}
const envView = (p, e) => ({
  env_id: e.id,
  name: e.name,
  is_current: selectedEnvironment(p).id === e.id,
  base_url: e.serverUrls?.[defaults(p).serverId] || "",
});
const variableView = (row) => ({
  key: row.key,
  value: row.initialValue ?? "",
  current_value: row.currentValue ?? "",
  description: row.description,
});
export function isNativeEnvironmentTool(kind) {
  return operations.some(([name]) => name === kind);
}
export function nativeEnvironmentTools(write) {
  return operations
    .filter(([, , , mutating]) => write || !mutating)
    .map(([name, properties, required]) => ({
      name: "apipost_" + name,
      description:
        "原版环境输入兼容：" +
        name +
        "；使用Workbench项目ID并保留写权限和默认资源保护",
      inputSchema: {
        type: "object",
        properties: { ...project, ...properties },
        required: ["project_id", ...required],
        additionalProperties: false,
      },
    }));
}
export async function executeNativeEnvironmentTool(store, p, kind, args) {
  const spec = operations.find(([name]) => name === kind);
  if (!spec) throw Error("原版环境工具不存在");
  validateEnvironmentModel(p);
  if (kind.startsWith("delete_") && args.confirm !== true)
    throw Error("删除操作必须显式confirm:true");
  const d = spec[3] ? ensureNativeDefaults(p) : defaults(p);
  let result;
  if (kind === "list_environments")
    return {
      current_env_id: selectedEnvironment(p).id,
      environments: p.environments.map((e) => envView(p, e)),
    };
  if (kind === "switch_environment") {
    const e = environment(p, args.environment_id);
    p.currentEnvironmentId = e.id;
    result = { current_env_id: e.id, name: e.name };
  } else if (kind === "create_environment") {
    const e = {
      id: randomUUID(),
      name: textName(args.name),
      variables: {},
      variableDefinitions: {},
      serverUrls: Object.fromEntries(p.servers.map((s) => [s.id, ""])),
    };
    if (own(args, "base_url"))
      e.serverUrls[d.serverId] = address(args.base_url);
    p.environments.push(e);
    result = { environment: envView(p, e) };
  } else if (kind === "update_environment") {
    const e = environment(p, args.environment_id);
    if (own(args, "name")) e.name = textName(args.name);
    if (own(args, "base_url"))
      (e.serverUrls ??= {})[d.serverId] = address(args.base_url);
    result = { environment: envView(p, e) };
  } else if (kind === "delete_environment") {
    const e = environment(p, args.environment_id);
    if (e.id === d.environmentId || e.id === "1")
      throw Error("默认环境不能删除");
    if (p.environments.length <= 1) throw Error("至少保留一个环境");
    p.environments = p.environments.filter((x) => x.id !== e.id);
    if (p.currentEnvironmentId === e.id)
      p.currentEnvironmentId = d.environmentId;
    result = { deleted: true, environment_id: e.id };
  } else if (kind === "list_environment_servers") {
    const e = own(args, "environment_id")
      ? environment(p, args.environment_id)
      : undefined;
    const servers = p.servers?.length
      ? p.servers
      : [{ id: d.serverId, name: "默认服务" }];
    return {
      ...(e ? { environment_id: e.id } : {}),
      servers: servers.map((s, i) => ({
        server_id: s.id,
        name: s.name,
        base_url:
          (e || p.environments.find((x) => own(x.serverUrls || {}, s.id)))
            ?.serverUrls?.[s.id] || "",
        sort: (i + 1) * 1000,
      })),
    };
  } else if (
    kind === "create_environment_server" ||
    kind === "update_environment_server"
  ) {
    if (own(args, "base_url") && !own(args, "environment_id"))
      throw Error("设置服务地址必须指定环境");
    const e = own(args, "environment_id")
      ? environment(p, args.environment_id)
      : undefined;
    let s;
    if (kind === "create_environment_server") {
      s = { id: randomUUID(), name: textName(args.name) };
      p.servers.push(s);
      for (const env of p.environments) (env.serverUrls ??= {})[s.id] = "";
    } else {
      s = service(p, args.server_id);
      if (own(args, "name")) s.name = textName(args.name);
    }
    if (own(args, "base_url"))
      (e.serverUrls ??= {})[s.id] = address(args.base_url);
    result = {
      server: {
        server_id: s.id,
        name: s.name,
        ...(kind === "create_environment_server"
          ? { uri: "", sort: p.servers.length * 1000 }
          : {}),
        base_url: e?.serverUrls?.[s.id] || "",
      },
    };
  } else if (kind === "delete_environment_server") {
    const s = service(p, args.server_id);
    if (s.id === d.serverId) throw Error("默认服务不能删除，请清空环境地址");
    p.servers = p.servers.filter((x) => x.id !== s.id);
    for (const e of p.environments) if (e.serverUrls) delete e.serverUrls[s.id];
    result = { deleted: true, server_id: s.id };
  } else {
    const global = kind.includes("global"),
      e = global ? null : environment(p, args.environment_id);
    const values = global ? p.globalVariables || {} : e.variables || {},
      defs = global
        ? p.globalVariableDefinitions || {}
        : e.variableDefinitions || {};
    const rows = variableRows(values, defs).map((row) => ({
      ...row,
      initialValue: own(defs, row.key) ? row.initialValue : "",
    }));
    if (kind.startsWith("get_"))
      return {
        ...(!global ? { environment_id: e.id } : {}),
        variables: rows.map(variableView),
      };
    const key = textName(args.key);
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw Error("不允许的变量键");
    if (kind.startsWith("delete_")) {
      if (!own(values, key) && !own(defs, key)) throw Error("变量不存在");
      delete values[key];
      delete defs[key];
      result = { deleted: true, key };
    } else {
      const old = rows.find((row) => row.key === key);
      const updated = updateVariable(values, defs, {
        key,
        initialValue: own(args, "value")
          ? args.value
          : old
            ? old.initialValue
            : "",
        currentValue: own(args, "current_value")
          ? args.current_value
          : own(values, key)
            ? values[key]
            : (old?.initialValue ?? ""),
        description: own(args, "description")
          ? args.description
          : old?.description || "",
      });
      if (global) {
        p.globalVariables = updated.values;
        p.globalVariableDefinitions = updated.definitions;
      } else {
        e.variables = updated.values;
        e.variableDefinitions = updated.definitions;
      }
      result = { variable: variableView(updated.variable) };
    }
  }
  if (spec[3]) await store.save(p);
  return result;
}
