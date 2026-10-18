import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, executeRequest } from "./runtime.mjs";
import { importIntoProject, snapshotPlan, runPlan } from "./core.mjs";
import {
  environmentVariables,
  debugEnvironment,
  resolveServiceRequest,
} from "./environments.mjs";
import {
  environmentTools,
  isEnvironmentTool,
  executeEnvironmentTool,
} from "./mcp-environments.mjs";
export function createMCP({
  store,
  projects = [],
  write = false,
  execute = false,
  debugEnvironments = new Map(),
}) {
  const allowed = new Set(projects);
  const tools = [
    ["localapi_list_projects", "列出已明确授权的本地项目", {}],
    [
      "localapi_list_apis",
      "列出项目接口",
      {
        projectId: { type: "string" },
        keyword: { type: "string" },
        folder: { type: "string" },
      },
    ],
    [
      "localapi_get_api_detail",
      "读取接口快照",
      { projectId: { type: "string" }, apiId: { type: "string" } },
    ],
    [
      "localapi_list_plans",
      "读取固定执行计划与最近运行摘要",
      { projectId: { type: "string" } },
    ],
    [
      "localapi_get_run",
      "读取逐步执行证据",
      { projectId: { type: "string" }, runId: { type: "string" } },
    ],
    ...(write
      ? [
          [
            "localapi_sync_openapi",
            "向授权项目导入 OpenAPI（不会执行请求）",
            { projectId: { type: "string" }, document: { type: "object" } },
          ],
          [
            "localapi_save_plan",
            "保存可观察的独立快照计划",
            { projectId: { type: "string" }, plan: { type: "object" } },
          ],
          [
            "localapi_delete_apis",
            "软删除指定接口",
            {
              projectId: { type: "string" },
              apiIds: { type: "array", items: { type: "string" } },
            },
          ],
        ]
      : []),
    ...(write && execute
      ? [
          [
            "localapi_run_plan",
            "执行已保存的计划，仅在额外执行授权下可用",
            { projectId: { type: "string" }, planId: { type: "string" } },
          ],
        ]
      : []),
  ].map(([name, description, properties]) => ({
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required: Object.keys(properties).filter(
        (k) => !["keyword", "folder"].includes(k),
      ),
      additionalProperties: false,
    },
  }));
  tools.push(...environmentTools(write));
  function addTool(
    name,
    description,
    properties,
    required = Object.keys(properties),
  ) {
    tools.push({
      name: "localapi_" + name,
      description,
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    });
  }
  const str = { type: "string" },
    projectArg = { projectId: str };
  addTool("list_execution_flows", "查询计划摘要", projectArg);
  addTool("get_execution_flow", "按ID读取完整计划", {
    ...projectArg,
    planId: str,
  });
  addTool(
    "list_execution_runs",
    "查询运行摘要",
    { ...projectArg, planId: str },
    ["projectId"],
  );
  addTool("get_execution_result", "读取逐步证据", {
    ...projectArg,
    runId: str,
  });
  if (write) {
    addTool("create_project", "创建并授权新本地项目", { name: str });
    addTool("create_execution_flow", "创建新计划", {
      ...projectArg,
      plan: { type: "object" },
    });
    addTool("update_execution_flow", "更新已有计划", {
      ...projectArg,
      plan: { type: "object" },
    });
    addTool("delete_execution_flow", "删除指定计划，保留历史证据", {
      ...projectArg,
      planId: str,
    });
    if (execute) {
      addTool("execute_flow", "执行已有计划", { ...projectArg, planId: str });
      addTool(
        "execute_api",
        "执行已有HTTP接口并记录证据",
        { ...projectArg, apiId: str, environmentId: str },
        ["projectId", "apiId"],
      );
    }
  }
  return async function dispatch(message) {
    const { id: requestId, method, params = {} } = message;
    if (requestId === undefined) return null;
    const result = (value) => ({
      jsonrpc: "2.0",
      id: requestId,
      result: value,
    });
    if (method === "initialize")
      return result({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "local-api-workbench", version: "0.1.0" },
      });
    if (method === "ping") return result({});
    if (method === "tools/list") return result({ tools });
    if (method !== "tools/call")
      return {
        jsonrpc: "2.0",
        id: requestId,
        error: { code: -32601, message: "Method not found" },
      };
    try {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) throw Error("工具不存在或未授权");
      const args = params.arguments || {};
      for (const key of tool.inputSchema.required)
        if (!Object.hasOwn(args, key)) throw Error("缺少参数 " + key);
      for (const [key, value] of Object.entries(args)) {
        const schema = tool.inputSchema.properties[key];
        if (!schema) throw Error("未知参数 " + key);
        if (schema.type === "string" && typeof value !== "string")
          throw Error("参数必须为字符串 " + key);
        if (
          schema.type === "object" &&
          (!value || typeof value !== "object" || Array.isArray(value))
        )
          throw Error("参数必须为对象 " + key);
        if (schema.type === "array" && !Array.isArray(value))
          throw Error("参数必须为数组 " + key);
      }
      let output;
      if (params.name === "localapi_list_projects")
        output = (await store.list()).filter(
          (p) => allowed.has(p.id) && !p.archived,
        );
      else if (params.name === "localapi_create_project") {
        if (!args.name.trim()) throw Error("项目名称不能为空");
        output = await store.create(args.name);
        allowed.add(output.id);
        projects.push(output.id);
      } else {
        if (!allowed.has(args.projectId)) throw Error("项目未授权");
        const p = await store.get(args.projectId);
        if (p.archived) throw Error("项目已归档");
        if (isEnvironmentTool(params.name)) {
          output = await executeEnvironmentTool(store, p, params.name, args);
          if (params.name === "localapi_get_environment_variables")
            output.runtimeVariables = debugEnvironment(
              p,
              args.environmentId,
              debugEnvironments,
            ).variables;
        } else
          switch (params.name) {
            case "localapi_list_apis": {
              const folders = [
                ...new Set([
                  ...(p.folders || []),
                  ...p.requests
                    .filter((r) => !r.deletedAt && r.folder)
                    .map((r) => r.folder),
                ]),
              ];
              output = [
                ...folders.map((folder) => ({
                  id: "folder:" + folder,
                  type: "folder",
                  name: folder,
                  folder,
                })),
                ...p.requests
                  .filter((r) => !r.deletedAt)
                  .map(({ id, name, method, url, folder }) => ({
                    id,
                    type: "api",
                    name,
                    method,
                    url,
                    folder,
                  })),
                ...(p.documents || []).map((document) => ({
                  id: document.id,
                  type: "document",
                  name: document.title,
                  folder: document.folder || "",
                })),
              ].filter(
                (item) =>
                  (!args.folder || item.folder === args.folder) &&
                  (!args.keyword ||
                    (item.name + " " + (item.url || "")).includes(
                      args.keyword,
                    )),
              );
              break;
            }
            case "localapi_get_api_detail":
              output = p.requests.find(
                (r) => r.id === args.apiId && !r.deletedAt,
              );
              if (!output) throw Error("接口不存在");
              break;
            case "localapi_list_plans":
              output = {
                plans: p.plans,
                runs: p.runs.map(
                  ({ id, planName, status, createdAt, planHash }) => ({
                    id,
                    planName,
                    status,
                    createdAt,
                    planHash,
                  }),
                ),
              };
              break;
            case "localapi_get_execution_result":
            case "localapi_get_run":
              output = p.runs.find((r) => r.id === args.runId);
              if (!output) throw Error("记录不存在");
              break;
            case "localapi_sync_openapi":
              output = importIntoProject(p, args.document, { sync: true });
              await store.save(p);
              break;
            case "localapi_create_execution_flow":
            case "localapi_update_execution_flow":
            case "localapi_save_plan":
              if (
                params.name === "localapi_create_execution_flow" &&
                args.plan.id &&
                p.plans.some((item) => item.id === args.plan.id)
              )
                throw Error("计划已存在");
              if (
                params.name === "localapi_update_execution_flow" &&
                !p.plans.some((item) => item.id === args.plan.id)
              )
                throw Error("计划不存在");
              output = snapshotPlan({
                ...args.plan,
                updatedAt: new Date().toISOString(),
                source: "ai",
              });
              const index = p.plans.findIndex((r) => r.id === output.id);
              if (index < 0) p.plans.push(output);
              else p.plans[index] = output;
              await store.save(p);
              break;
            case "localapi_delete_apis":
              if (!Array.isArray(args.apiIds)) throw Error("apiIds 必须为数组");
              output = [];
              for (const r of p.requests)
                if (args.apiIds.includes(r.id)) {
                  r.deletedAt = new Date().toISOString();
                  output.push(r.id);
                }
              await store.save(p);
              break;
            case "localapi_list_execution_flows":
              output = p.plans.map(
                ({
                  id,
                  name,
                  description,
                  updatedAt,
                  environmentId,
                  steps,
                }) => ({
                  id,
                  name,
                  description,
                  updatedAt,
                  environmentId,
                  stepCount: steps.length,
                }),
              );
              break;
            case "localapi_get_execution_flow":
              output = p.plans.find((item) => item.id === args.planId);
              if (!output) throw Error("计划不存在");
              break;
            case "localapi_delete_execution_flow":
              if (!p.plans.some((item) => item.id === args.planId))
                throw Error("计划不存在");
              p.plans = p.plans.filter((item) => item.id !== args.planId);
              await store.save(p);
              output = { deletedId: args.planId };
              break;
            case "localapi_list_execution_runs":
              output = p.runs
                .filter((run) => !args.planId || run.planId === args.planId)
                .map(
                  ({ id, planId, planName, status, createdAt, planHash }) => ({
                    id,
                    planId,
                    planName,
                    status,
                    createdAt,
                    planHash,
                  }),
                );
              break;
            case "localapi_execute_api": {
              const request = p.requests.find(
                (item) => item.id === args.apiId && !item.deletedAt,
              );
              if (!request) throw Error("接口不存在");
              const plan = snapshotPlan({
                name: request.name,
                steps: [
                  {
                    request: resolveServiceRequest(
                      p,
                      request,
                      args.environmentId,
                    ),
                  },
                ],
              });
              output = await runPlan(
                plan,
                debugEnvironment(p, args.environmentId, debugEnvironments)
                  .variables,
                executeRequest,
              );
              const context = debugEnvironment(
                p,
                args.environmentId,
                debugEnvironments,
              );
              if (output.results[0]?.response)
                debugEnvironments.set(context.cacheKey, {
                  fingerprint: context.fingerprint,
                  variables: output.variables,
                });
              await store.append(p.id, "history", {
                id: output.id,
                createdAt: output.createdAt,
                name: request.name,
                ...output.results[0],
              });
              break;
            }
            case "localapi_execute_flow":
            case "localapi_run_plan": {
              const plan = p.plans.find((r) => r.id === args.planId);
              if (!plan) throw Error("计划不存在");
              output = await runPlan(
                plan,
                environmentVariables(p, plan.environmentId),
                executeRequest,
                {
                  prepareRequest: (request) =>
                    resolveServiceRequest(p, request, plan.environmentId),
                },
              );
              await store.append(p.id, "runs", output);
              break;
            }
          }
      }
      return result({
        content: [{ type: "text", text: JSON.stringify(output) }],
      });
    } catch (e) {
      return result({
        isError: true,
        content: [{ type: "text", text: e.message }],
      });
    }
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2),
    projects = argv.flatMap((a, i) => (a === "--project" ? [argv[i + 1]] : [])),
    store = new Store(path.resolve(process.env.LOCAL_API_DATA || ".local-api"));
  await store.init();
  const dispatch = createMCP({
    store,
    projects,
    write: argv.includes("--write"),
    execute: argv.includes("--execute"),
  });
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    try {
      if (Buffer.byteLength(line) > 12 * 1024 * 1024)
        throw Error("Input too large");
      const answer = await dispatch(JSON.parse(line));
      if (answer) process.stdout.write(JSON.stringify(answer) + "\n");
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }) + "\n",
      );
    }
  }
}
