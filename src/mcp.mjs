import { executeWireFlow } from "./wire-plan.mjs";
import { executeSocketIOFlow } from "./socketio-plan.mjs";
import { SocketIOSessions } from "./socketio.mjs";
import { recordPlanRun } from "./plan-evidence.mjs";
import { executeGrpc } from "./grpc.mjs";
import { syncMCPOpenAPI } from "./mcp-openapi-sync.mjs";
import { applyMCPInput } from "./mcp-request-input.mjs";
import {
  listExecutionHistory,
  findExecutionResult,
} from "./execution-history.mjs";
import { freezeServiceBinding } from "./environments.mjs";
import { projectCookieSession } from "./cookie-jar.mjs";
import { MCPActivity } from "./mcp-activity.mjs";
import { scopedExecution } from "./variable-scopes.mjs";
import { versionPlan } from "./plan-version.mjs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, executeRequest } from "./runtime.mjs";
import { snapshotPlan, runPlan } from "./core.mjs";
import {
  environmentVariables,
  selectedEnvironment,
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
  onProgress = () => {},
  grpcExecutor = executeGrpc,
  protocolExecutor = executeWireFlow,
  socketioExecutor,
  databaseExecutor,
}) {
  const allowed = new Set(projects);
  const socketioSessions = new SocketIOSessions();
  const executePlanSocketIO = (projectId, input, signal) => {
    if (!write || !execute) throw Error("Socket.IO执行未授权");
    return socketioExecutor
      ? socketioExecutor(projectId, input, signal)
      : executeSocketIOFlow(input, signal, {
          sessions: socketioSessions,
          projectId,
        });
  };
  let protocolActive = 0;
  const executePlanProtocol = async (input, signal) => {
    if (!write || !execute) throw Error("协议计划执行未授权");
    if (protocolActive >= 5) throw Error("最多同时执行5个通用协议调用");
    protocolActive++;
    try {
      return await protocolExecutor(input, signal);
    } finally {
      protocolActive--;
    }
  };
  let grpcActive = 0;
  const executePlanGrpc = async (input, signal) => {
    if (!write || !execute) throw Error("gRPC执行未授权");
    if (grpcActive >= 5) throw Error("最多同时执行5个gRPC调用");
    grpcActive++;
    try {
      return await grpcExecutor(input, signal);
    } finally {
      grpcActive--;
    }
  };
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
            {
              projectId: { type: "string" },
              document: { oneOf: [{ type: "object" }, { type: "string" }] },
              folder: { type: "string" },
              coverMode: {
                type: "string",
                enum: ["url_and_folder", "url", "ignore", "both"],
              },
              apiScripts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    method: { type: "string" },
                    url: { type: "string" },
                    beforeScript: { type: "string" },
                    afterScript: { type: "string" },
                  },
                  required: ["method", "url"],
                  additionalProperties: false,
                },
              },
            },
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
            {
              projectId: { type: "string" },
              planId: { type: "string" },
              grpcCredentials: { type: "object" },
              protocolCredentials: { type: "object" },
              socketioCredentials: { type: "object" },
            },
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
        (k) =>
          ![
            "keyword",
            "folder",
            "coverMode",
            "apiScripts",
            "grpcCredentials",
            "protocolCredentials",
            "socketioCredentials",
          ].includes(k),
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
  addTool(
    "list_grpc_definitions",
    "读取项目gRPC定义摘要，不连接远端",
    projectArg,
  );
  addTool("get_grpc_definition", "读取gRPC完整定义供计划冻结，不连接远端", {
    ...projectArg,
    definitionId: str,
  });
  addTool(
    "list_socketio_definitions",
    "读取项目Socket.IO定义摘要，不连接远端",
    projectArg,
  );
  addTool(
    "get_socketio_definition",
    "读取Socket.IO完整定义供计划冻结，不连接远端",
    { ...projectArg, definitionId: str },
  );
  addTool(
    "list_protocol_runs",
    "读取项目最近协议执行摘要，不返回消息正文",
    projectArg,
  );
  addTool("get_protocol_run", "按记录ID读取项目协议执行证据，不重放网络请求", {
    ...projectArg,
    recordId: str,
  });
  addTool("list_execution_flows", "查询计划摘要", projectArg);
  addTool("get_execution_flow", "按ID读取完整计划", {
    ...projectArg,
    planId: str,
  });
  addTool(
    "list_execution_runs",
    "查询最近执行摘要，默认 20 条、最多 50 条，不含请求响应正文",
    {
      ...projectArg,
      planId: str,
      scope: { type: "string", enum: ["api", "flow"] },
      source: { type: "string", enum: ["manual", "mcp", "cli", "unknown"] },
      status: { type: "string", enum: ["passed", "failed", "cancelled"] },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    },
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
      addTool(
        "execute_flow",
        "执行已有计划，可临时指定环境而不改写计划默认值",
        {
          ...projectArg,
          planId: str,
          environmentId: str,
          grpcCredentials: { type: "object" },
          socketioCredentials: { type: "object" },
        },
        ["projectId", "planId"],
      );
      addTool(
        "execute_api",
        "执行已有HTTP接口，可临时覆盖已定义输入；历史证据可能包含输入值",
        {
          ...projectArg,
          apiId: str,
          environmentId: str,
          input: {
            type: "object",
            properties: {
              query: { type: "object" },
              path: { type: "object" },
              headers: { type: "object" },
              cookies: { type: "object" },
              body: {},
              auth: { type: "object" },
            },
            additionalProperties: false,
          },
        },
        ["projectId", "apiId"],
      );
    }
  }
  for (const tool of tools) {
    if (!tool.name.startsWith("localapi_delete_")) continue;
    tool.inputSchema.properties.confirm = {
      type: "boolean",
      const: true,
      description: "本次删除操作必须显式确认；不替代项目写权限",
    };
    tool.inputSchema.required = [...tool.inputSchema.required, "confirm"];
    tool.description += "；必须显式传入 confirm: true";
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
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw Error("参数必须为对象");
      for (const key of tool.inputSchema.required)
        if (!Object.hasOwn(args, key)) throw Error("缺少参数 " + key);
      for (const [key, value] of Object.entries(args)) {
        if (!Object.hasOwn(tool.inputSchema.properties, key))
          throw Error("未知参数 " + key);
        const schema = tool.inputSchema.properties[key];
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
      if (tool.name.startsWith("localapi_delete_") && args.confirm !== true)
        throw Error("删除操作必须显式传入 confirm: true");
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
            case "localapi_list_protocol_runs":
              output = (p.protocolRuns || []).map(
                ({ id, runId, type, mode, status, createdAt, durationMs }) => ({
                  id,
                  runId,
                  type,
                  ...(mode ? { mode } : {}),
                  status,
                  createdAt,
                  ...(durationMs !== undefined ? { durationMs } : {}),
                }),
              );
              break;
            case "localapi_get_protocol_run":
              output = (p.protocolRuns || []).find(
                (record) => record.id === args.recordId,
              );
              if (!output) throw Error("协议执行记录不存在");
              break;
            case "localapi_list_socketio_definitions":
              output = (p.settings?.socketioDefinitions || []).map(
                ({ id, name, url, path }) => ({ id, name, url, path }),
              );
              break;
            case "localapi_get_socketio_definition":
              output = (p.settings?.socketioDefinitions || []).find(
                (x) => x.id === args.definitionId,
              );
              if (!output) throw Error("Socket.IO定义不存在");
              break;
            case "localapi_list_grpc_definitions":
              output = (p.settings?.grpcDefinitions || []).map(
                ({ id, name, target, service, method }) => ({
                  id,
                  name,
                  target,
                  service,
                  method,
                }),
              );
              break;
            case "localapi_get_grpc_definition":
              output = (p.settings?.grpcDefinitions || []).find(
                (x) => x.id === args.definitionId,
              );
              if (!output) throw Error("gRPC定义不存在");
              break;
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
                ...(p.protocols || []).map((protocol) => ({
                  id: protocol.id,
                  type: protocol.type,
                  name: protocol.name,
                  url: protocol.url,
                  folder: protocol.folder || "",
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
              output = [...p.requests, ...(p.protocols || [])].find(
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
              output = findExecutionResult(p, args.runId);
              break;
            case "localapi_get_run":
              output = p.runs.find((r) => r.id === args.runId);
              if (!output) throw Error("记录不存在");
              break;
            case "localapi_sync_openapi":
              output = syncMCPOpenAPI(p, args);
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
              output = versionPlan(
                p.plans.find((item) => item.id === args.plan.id),
                {
                  ...args.plan,
                  functions: args.plan.functions || p.settings?.functions || [],
                },
                "ai",
                p,
              );
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
              output = listExecutionHistory(p, args);
              break;
            case "localapi_execute_api": {
              const request = p.requests.find(
                (item) => item.id === args.apiId && !item.deletedAt,
              );
              if (!request) throw Error("接口不存在");
              const plan = snapshotPlan({
                name: request.name,
                functions: p.settings?.functions || [],
                steps: [
                  {
                    request: applyMCPInput(
                      resolveServiceRequest(
                        p,
                        freezeServiceBinding(p, request),
                        args.environmentId,
                      ),
                      args.input,
                    ),
                  },
                ],
              });
              output = await runPlan(
                plan,
                debugEnvironment(p, args.environmentId, debugEnvironments)
                  .variables,
                executeRequest,
                {
                  databaseQuery: databaseExecutor
                    ? (operation, signal) =>
                        databaseExecutor(p.id, operation, signal)
                    : undefined,
                  cookieSession: projectCookieSession(
                    store,
                    p,
                    args.environmentId,
                  ),
                  ...scopedExecution(
                    store,
                    p,
                    args.environmentId,
                    debugEnvironment(p, args.environmentId, debugEnvironments)
                      .variables,
                  ),
                  onStep: (step) =>
                    onProgress({
                      completed: 1,
                      total: 1,
                      stepId: step.stepId,
                      status: step.status,
                    }),
                },
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
                source: "mcp",
                durationMs: output.durationMs,
              });
              break;
            }
            case "localapi_execute_flow":
            case "localapi_run_plan": {
              const plan = p.plans.find((r) => r.id === args.planId);
              if (!plan) throw Error("计划不存在");
              const environmentId = selectedEnvironment(
                p,
                args.environmentId || plan.environmentId,
              ).id;
              let completed = 0;
              output = await runPlan(
                plan,
                environmentVariables(p, environmentId),
                executeRequest,
                {
                  ...scopedExecution(store, p, environmentId),
                  databaseQuery: databaseExecutor
                    ? (operation, signal) =>
                        databaseExecutor(p.id, operation, signal)
                    : undefined,
                  executeGrpc: executePlanGrpc,
                  grpcCredentials: args.grpcCredentials,
                  executeProtocol: executePlanProtocol,
                  protocolCredentials: args.protocolCredentials,
                  executeSocketIO: (input, signal) =>
                    executePlanSocketIO(p.id, input, signal),
                  socketioCredentials: args.socketioCredentials,
                  cookieSession: projectCookieSession(store, p, environmentId),
                  onStep: (step) =>
                    onProgress({
                      completed: ++completed,
                      total: plan.steps.filter((s) => s.enabled !== false)
                        .length,
                      stepId: step.stepId,
                      stepStatus: step.status,
                    }),
                  prepareRequest: (request) =>
                    resolveServiceRequest(p, request, environmentId),
                },
              );
              output.environmentId = environmentId;
              output = await recordPlanRun(store, p.id, output, "mcp");
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
  let activity;
  const dispatch = createMCP({
    store,
    projects,
    write: argv.includes("--write"),
    execute: argv.includes("--execute"),
    onProgress: (progress) => activity?.update(progress),
  });
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    let message;
    try {
      if (Buffer.byteLength(line) > 12 * 1024 * 1024)
        throw Error("Input too large");
      message = JSON.parse(line);
      if (
        message.method === "tools/call" &&
        argv.includes("--execute") &&
        argv.includes("--write") &&
        projects.includes(message.params?.arguments?.projectId) &&
        [
          "localapi_run_plan",
          "localapi_execute_flow",
          "localapi_execute_api",
        ].includes(message.params?.name)
      ) {
        activity = await new MCPActivity(store.root, {
          tool: message.params.name,
          projectId: message.params.arguments.projectId,
          planId: message.params.arguments.planId,
        }).start();
      }
      const answer = await dispatch(message);
      await activity?.finish(Boolean(answer?.result?.isError));
      activity = undefined;
      if (answer) process.stdout.write(JSON.stringify(answer) + "\n");
    } catch (error) {
      await activity?.finish(true).catch(() => {});
      activity = undefined;
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message?.id ?? null,
          error:
            error instanceof SyntaxError
              ? { code: -32700, message: "Parse error" }
              : { code: -32603, message: "Execution/progress storage failed" },
        }) + "\n",
      );
    }
  }
}
