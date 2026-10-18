import { manageEnvironment } from "./environments.mjs";
const string = { type: "string" },
  any = {};
const environmentOperations = [
  ["list_environments", "查询环境与当前选择", {}, [], false],
  [
    "switch_environment",
    "切换当前环境",
    { environmentId: string },
    ["environmentId"],
    true,
  ],
  [
    "create_environment",
    "创建环境",
    { name: string, baseUrl: string },
    ["name"],
    true,
  ],
  [
    "update_environment",
    "更新环境名称及默认地址",
    { environmentId: string, name: string, baseUrl: string },
    ["environmentId"],
    true,
  ],
  [
    "delete_environment",
    "删除环境（保留至少一个）",
    { environmentId: string },
    ["environmentId"],
    true,
  ],
  [
    "list_environment_servers",
    "列出共享服务与环境地址",
    { environmentId: string },
    [],
    false,
  ],
  [
    "create_environment_server",
    "创建共享服务并设置环境地址",
    { environmentId: string, name: string, url: string },
    ["environmentId", "name", "url"],
    true,
  ],
  [
    "update_environment_server",
    "修改共享服务名称或环境地址",
    { serverId: string, environmentId: string, name: string, url: string },
    ["serverId", "environmentId"],
    true,
  ],
  [
    "delete_environment_server",
    "删除共享服务及各环境地址",
    { serverId: string },
    ["serverId"],
    true,
  ],
  [
    "get_environment_variables",
    "读取环境和有效变量",
    { environmentId: string },
    [],
    false,
  ],
  [
    "upsert_environment_variable",
    "设置环境变量",
    { environmentId: string, key: string, value: any },
    ["environmentId", "key", "value"],
    true,
  ],
  [
    "delete_environment_variable",
    "删除环境变量",
    { environmentId: string, key: string },
    ["environmentId", "key"],
    true,
  ],
  ["get_global_variables", "读取项目全局变量", {}, [], false],
  [
    "upsert_global_variable",
    "设置全局变量",
    { key: string, value: any },
    ["key", "value"],
    true,
  ],
  ["delete_global_variable", "删除全局变量", { key: string }, ["key"], true],
];
export function environmentTools(write) {
  return environmentOperations
    .filter((row) => write || !row[4])
    .map(([name, description, properties, required]) => ({
      name: "localapi_" + name,
      description,
      inputSchema: {
        type: "object",
        properties: { projectId: string, ...properties },
        required: ["projectId", ...required],
        additionalProperties: false,
      },
    }));
}
export function isEnvironmentTool(name) {
  return environmentOperations.some((row) => "localapi_" + row[0] === name);
}
export async function executeEnvironmentTool(store, project, name, args) {
  const operation = name.slice("localapi_".length),
    spec = environmentOperations.find((row) => row[0] === operation);
  const result = manageEnvironment(project, operation, args);
  if (spec[4]) await store.save(project);
  return result;
}
