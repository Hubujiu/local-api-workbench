import { activePlanStepCount } from "./plan-repeat.mjs";
import { assertNativeInheritanceMCPInput } from "./native-inheritance.mjs";
import {
  listImportedExecutionRuns,
  getImportedExecutionRun,
} from "./imported-execution-history.mjs";
import {
  executeNativeEnvironmentTool,
  resolveNativeEnvironment,
} from "./native-mcp-environments.mjs";
import { deleteAPIResources } from "./api-resource-lifecycle.mjs";
import {
  nativeMCPTools,
  translateNativeCall,
  nativeAPIList,
  nativeAPIDetail,
  nativeRunResult,
  assertNativeLinearResult,
  nativeExecutionHistory,
} from "./native-mcp-tools.mjs";
import {
  buildNativeMCPPlan,
  assertNativeLinearPlan,
  nativeFlowView,
  inputAuth,
} from "./native-mcp-plan.mjs";
import { lockMCPPlan } from "./mcp-plan-locks.mjs";
import { appendExecutionRecord } from "./execution-evidence.mjs";

import { publicProjectCommitOutcome } from "./project-commit-outcome.mjs";
import { realpathSync } from "node:fs";
import { executeWireFlow } from "./wire-plan.mjs";
import { executeSocketIOFlow } from "./socketio-plan.mjs";
import { SocketIOSessions } from "./socketio.mjs";
import { recordPlanRun } from "./plan-evidence.mjs";
import { executeGrpc } from "./grpc.mjs";
import { syncMCPOpenAPI } from "./mcp-openapi-sync.mjs";
import {
  importMCPProject,
  exportMCPProject,
  validateMCPProjectArguments,
} from "./mcp-project-interchange.mjs";
import { applyMCPInput } from "./mcp-request-input.mjs";
import {
  listExecutionHistory,
  findExecutionResult,
} from "./execution-history.mjs";
import {
  executionResultChunk,
  executionResultChunkArguments,
  executionResultChunkError,
  EXECUTION_RESULT_CHUNK_DEFAULT_BYTES,
  EXECUTION_RESULT_CHUNK_MAX_BYTES,
} from "./execution-result-chunk.mjs";
import { freezeServiceBinding } from "./environments.mjs";
import { projectCookieSession } from "./cookie-jar.mjs";
import { MCPActivity } from "./mcp-activity.mjs";
import { scopedExecution } from "./variable-scopes.mjs";
import { versionPlan } from "./plan-version.mjs";
import { fileURLToPath } from "node:url";
import { executeRequest } from "./runtime.mjs";
import { snapshotPlan, runPlan, normalizeRequest } from "./core.mjs";
import {
  environmentVariables,
  selectedEnvironment,
  debugEnvironment,
  createServiceRequestResolver,
} from "./environments.mjs";
import {
  environmentTools,
  isEnvironmentTool,
  executeEnvironmentTool,
} from "./mcp-environments.mjs";
export function createMCP({
  store,
  projects = [],
  sessionProjects = [],
  write = false,
  execute = false,
  debugEnvironments = new Map(),
  onProgress = () => {},
  grpcExecutor = executeGrpc,
  protocolExecutor = executeWireFlow,
  socketioExecutor,
  databaseExecutor,
}) {
  const allowed = new Set([...projects, ...sessionProjects]);
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
            "保存独立快照计划；支持单层HTTP repeat组，count为1至100整数，潜在展开最多200步",
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
  const projectFormat = {
    type: "string",
    enum: ["apipost", "apipost-directory"],
  };
  addTool(
    "export_project",
    "导出已授权项目的 Apipost 定义 JSON；可能包含已保存的凭据，不执行请求",
    {
      ...projectArg,
      format: projectFormat,
      modelNameMode: { type: "string", enum: ["namespaced", "preserve"] },
    },
    ["projectId", "format"],
  );
  if (write)
    addTool(
      "import_project",
      "向已授权项目合并 Apipost 定义 JSON；不清空、不新建项目、不执行请求",
      {
        ...projectArg,
        format: projectFormat,
        inheritanceMode: { type: "string", enum: ["flatten", "preserve"] },
        modelNameMode: { type: "string", enum: ["namespaced", "preserve"] },
        document: {
          type: "object",
          description:
            "内联 JSON 对象，序列化 UTF-8 最多4MiB、64层；不是路径或URL",
        },
      },
      ["projectId", "format", "document"],
    );
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
  addTool(
    "list_imported_execution_runs",
    "只读查询导入的原版历史摘要；不是本工具新执行或验证的结果",
    {
      ...projectArg,
      sourceProjectId: str,
      offset: { type: "integer", minimum: 0, maximum: 1000, default: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    },
    ["projectId"],
  );
  addTool(
    "get_imported_execution_run",
    "只读查询原版历史来源档案；不执行、不授权、不验证历史结论",
    {
      ...projectArg,
      sourceProjectId: str,
      runId: str,
    },
  );
  addTool("get_execution_result", "读取逐步证据", {
    ...projectArg,
    runId: str,
  });
  addTool(
    "get_execution_result_chunk",
    "分块读取已保存的完整 JSON 执行证据；后续分块必须携带首次返回的 SHA-256，不重放执行",
    {
      projectId: { type: "string", minLength: 1, maxLength: 4096 },
      runId: { type: "string", minLength: 1, maxLength: 4096 },
      offsetBytes: {
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      maxBytes: {
        type: "integer",
        minimum: 1,
        maximum: EXECUTION_RESULT_CHUNK_MAX_BYTES,
        default: EXECUTION_RESULT_CHUNK_DEFAULT_BYTES,
      },
      expectedSha256: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
        description: "首次响应的 SHA-256；offsetBytes 大于 0 时必填",
      },
    },
    ["projectId", "runId", "offsetBytes"],
  );
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
          protocolCredentials: { type: "object" },
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
  tools.push(...nativeMCPTools(write, execute));
  return async function dispatch(
    message,
    { signal, onProgress: emitProgress = onProgress } = {},
  ) {
    const { id: requestId, method, params: incomingParams = {} } = message;
    let params = incomingParams;
    const nativeName =
      typeof params.name === "string" && params.name.startsWith("apipost_")
        ? params.name
        : null;
    let nativePlanArgs, nativeEnvironmentArgs, unlockPlan;
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
    // These bounded interchange tools cannot echo an unbounded/structured ID
    // even in their error envelope. Other tools retain their existing contract.
    const projectInterchange = [
      "localapi_import_project",
      "localapi_export_project",
    ].includes(params?.name);
    if (
      projectInterchange &&
      !(
        (typeof requestId === "string" &&
          Buffer.byteLength(requestId) <= 256) ||
        (typeof requestId === "number" && Number.isSafeInteger(requestId))
      )
    )
      return {
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message: "项目导入导出请求ID必须为安全整数或最多256字节的字符串",
        },
      };
    try {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) throw Error("工具不存在或未授权");
      let args = params.arguments === undefined ? {} : params.arguments;
      if (params.name === "localapi_get_execution_result_chunk")
        args = executionResultChunkArguments(args);
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw Error("参数必须为对象");
      if (projectInterchange) validateMCPProjectArguments(args);
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
      if (
        (tool.name.startsWith("localapi_delete_") ||
          tool.name.startsWith("apipost_delete_")) &&
        args.confirm !== true
      )
        throw Error("删除操作必须显式传入 confirm: true");
      if (nativeName) {
        const translated = translateNativeCall(nativeName, args);
        params = { ...params, name: translated.name };
        args = translated.args;
        nativePlanArgs = translated.planArgs;
        nativeEnvironmentArgs = translated.environmentArgs;
      }
      let output;
      if (params.name === "localapi_list_projects")
        output = (await store.list()).filter(
          (p) => allowed.has(p.id) && !p.archived,
        );
      else if (params.name === "localapi_create_project") {
        if (!args.name.trim()) throw Error("项目名称不能为空");
        if (nativeName) {
          if (args.name.trim().length > 64) throw Error("项目名称最多64字符");
          if (
            args.description !== undefined &&
            args.description.trim().length > 1024
          )
            throw Error("项目描述最多1024字符");
          if (args.storage_path?.trim())
            throw Error("MCP仅允许托管存储根目录；不接受自定义storage_path");
        }
        output = await store.create(
          nativeName ? args.name.trim() : args.name,
          undefined,
          nativeName
            ? { description: args.description?.trim() || "" }
            : undefined,
        );
        allowed.add(output.id);
        (nativeName ? sessionProjects : projects).push(output.id);
      } else {
        if (!allowed.has(args.projectId)) throw Error("项目未授权");
        const lockedOperations = [
          "localapi_save_plan",
          "localapi_create_execution_flow",
          "localapi_update_execution_flow",
          "localapi_delete_execution_flow",
          "localapi_execute_flow",
          "localapi_run_plan",
        ];
        const lockId = nativePlanArgs?.flow_id || args.planId || args.plan?.id;
        if (lockId && lockedOperations.includes(params.name))
          unlockPlan = lockMCPPlan(store, args.projectId, lockId);
        const p = await store.get(args.projectId);
        if (p.archived) throw Error("项目已归档");
        if (nativeName && Object.hasOwn(args, "environmentId"))
          args = {
            ...args,
            environmentId: resolveNativeEnvironment(p, args.environmentId).id,
          };

        if (nativePlanArgs) {
          const previous = nativePlanArgs.flow_id
            ? p.plans.find((x) => x.id === nativePlanArgs.flow_id)
            : undefined;
          if (params.name === "localapi_update_execution_flow" && !previous)
            throw Error("计划不存在");
          args = {
            projectId: p.id,
            plan: buildNativeMCPPlan(
              p,
              nativePlanArgs,
              previous,
              normalizeRequest,
            ),
          };
        }

        if (nativeEnvironmentArgs)
          output = await executeNativeEnvironmentTool(
            store,
            p,
            nativeName.slice(8),
            nativeEnvironmentArgs,
          );
        else if (isEnvironmentTool(params.name)) {
          output = await executeEnvironmentTool(store, p, params.name, args);
          if (params.name === "localapi_get_environment_variables")
            output.runtimeVariables = debugEnvironment(
              p,
              args.environmentId,
              debugEnvironments,
            ).variables;
        } else
          switch (params.name) {
            case "localapi_import_project":
              return result(await importMCPProject(store, p, args, requestId));
            case "localapi_export_project":
              return result(exportMCPProject(p, args, requestId));
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
              if (nativeName) {
                output = nativeAPIList(p, args);
                break;
              }
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
              if (nativeName) {
                output = nativeAPIDetail(p, args.apiId);
                break;
              }
              output = [
                ...p.requests,
                ...(p.protocols || []),
                ...(p.documents || []),
              ].find((r) => r.id === args.apiId && !r.deletedAt);
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
            case "localapi_get_execution_result_chunk":
              output = executionResultChunk(
                findExecutionResult(p, args.runId),
                args,
              );
              break;
            case "localapi_get_execution_result":
              output = findExecutionResult(p, args.runId);
              break;
            case "localapi_list_imported_execution_runs":
              output = listImportedExecutionRuns(p, args);
              break;
            case "localapi_get_imported_execution_run":
              output = getImportedExecutionRun(
                p,
                args.sourceProjectId,
                args.runId,
              );
              if (!output) throw Error("原始执行记录不存在");
              break;
            case "localapi_get_run":
              output = p.runs.find((r) => r.id === args.runId);
              if (!output) throw Error("记录不存在");
              break;
            case "localapi_sync_openapi":
              output = syncMCPOpenAPI(p, args, { native: !!nativeName });
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
                // Native args were just materialized by buildNativeMCPPlan from
                // this authorized project. Re-freezing its unbound snapshots
                // would reconnect fresh native steps to live definitions.
                nativePlanArgs ? undefined : p,
              );
              const index = p.plans.findIndex((r) => r.id === output.id);
              if (index < 0) p.plans.push(output);
              else p.plans[index] = output;
              await store.save(p);
              break;
            case "localapi_delete_apis":
              if (!Array.isArray(args.apiIds)) throw Error("apiIds 必须为数组");
              if (p.settings?.nativeInheritance) {
                await store.editNativeInheritance(
                  p.id,
                  {
                    configRevision: p.configRevision,
                    operation: {
                      type: "recycle-requests",
                      requestIds: args.apiIds,
                    },
                  },
                  { nativeTrash: Boolean(nativeName) },
                );
                output = [...args.apiIds];
                break;
              }
              if (nativeName) {
                const deletion = deleteAPIResources(p, args.apiIds);
                await store.save(deletion.project);
                output = deletion.selectedTargetIds;
                break;
              }
              output = [];
              for (const r of p.requests)
                if (args.apiIds.includes(r.id)) {
                  r.deletedAt = new Date().toISOString();
                  output.push(r.id);
                }
              await store.save(p);
              break;
            case "localapi_list_execution_flows":
              if (nativeName)
                for (const plan of p.plans) assertNativeLinearPlan(plan);
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
              output = nativeName
                ? nativeExecutionHistory(p, args)
                : listExecutionHistory(p, args);
              break;
            case "localapi_execute_api": {
              const request = p.requests.find(
                (item) => item.id === args.apiId && !item.deletedAt,
              );
              if (!request) throw Error("接口不存在");
              const environmentId = selectedEnvironment(
                p,
                args.environmentId,
              ).id;
              const effectiveRequest = createServiceRequestResolver(
                p,
                environmentId,
              )(freezeServiceBinding(p, request));
              const temporaryInput = nativeName
                ? inputAuth(effectiveRequest, args.input)
                : args.input;
              assertNativeInheritanceMCPInput(
                p,
                request,
                effectiveRequest,
                temporaryInput,
              );
              const plan = snapshotPlan({
                name: request.name,
                ...(nativeName ? { statusPolicy: "strict200" } : {}),
                functions: p.settings?.functions || [],
                steps: [
                  {
                    request: applyMCPInput(effectiveRequest, temporaryInput),
                  },
                ],
              });
              output = await runPlan(
                plan,
                debugEnvironment(p, environmentId, debugEnvironments).variables,
                executeRequest,
                {
                  signal,
                  databaseQuery: databaseExecutor
                    ? (operation, signal) =>
                        databaseExecutor(p.id, operation, signal)
                    : undefined,
                  cookieSession: projectCookieSession(store, p, environmentId),
                  ...scopedExecution(
                    store,
                    p,
                    environmentId,
                    debugEnvironment(p, environmentId, debugEnvironments)
                      .variables,
                  ),
                  onStep: (step) =>
                    emitProgress({
                      completed: 1,
                      total: 1,
                      stepId: step.stepId,
                      status: step.status,
                    }),
                },
              );
              const context = debugEnvironment(
                p,
                environmentId,
                debugEnvironments,
              );
              if (!signal?.aborted && output.results[0]?.response)
                debugEnvironments.set(context.cacheKey, {
                  fingerprint: context.fingerprint,
                  variables: output.variables,
                });
              output.environmentId = environmentId;
              const receipt = await appendExecutionRecord(
                store,
                p.id,
                "history",
                {
                  ...output.results[0],
                  id: output.id,
                  runId: output.id,
                  createdAt: output.createdAt,
                  name: request.name,
                  status: output.status,
                  source: "mcp",
                  durationMs: output.durationMs,
                  environmentId: output.environmentId,
                },
              );
              output = { ...output, ...receipt };
              break;
            }
            case "localapi_execute_flow":
            case "localapi_run_plan": {
              const plan = p.plans.find((r) => r.id === args.planId);
              if (!plan) throw Error("计划不存在");
              if (nativeName) assertNativeLinearPlan(plan);
              const totalSteps = activePlanStepCount(plan);
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
                  signal,
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
                    emitProgress({
                      completed: ++completed,
                      total: totalSteps,
                      ...(step.repeat ? { repeat: step.repeat } : {}),
                      stepId: step.stepId,
                      stepStatus: step.status,
                    }),
                  prepareRequest: createServiceRequestResolver(
                    p,
                    environmentId,
                  ),
                },
              );
              output.environmentId = environmentId;
              output = await recordPlanRun(store, p.id, output, "mcp");
              break;
            }
          }
      }
      if (nativeName) {
        const kind = nativeName.slice(8);
        if (kind === "create_project")
          output = {
            project_id: output.id,
            name: output.name,
            description: output.description,
            storage_path: store.directory(output.id),
            authorized: true,
          };
        else if (kind === "delete_apis")
          output = {
            project_id: args.projectId,
            deleted: output.length,
            target_ids: output,
          };
        else if (kind === "list_projects")
          output = {
            projects: output.map((p) => ({
              project_id: p.id,
              name: p.name,
              intro: p.description || "",
            })),
          };
        else if (
          kind === "create_execution_flow" ||
          kind === "update_execution_flow"
        )
          output = {
            flow_id: output.id,
            name: output.name,
            message: "计划已保存",
          };
        else if (kind === "list_execution_flows")
          output = {
            flows: output.map((p) => ({
              flow_id: p.id,
              project_id: args.projectId,
              name: p.name,
              description: p.description,
              environment_id: p.environmentId,
              step_count: p.stepCount,
              updated_at: p.updatedAt,
            })),
          };
        else if (kind === "get_execution_flow")
          output = { flow: nativeFlowView(args.projectId, output) };
        else if (kind === "delete_execution_flow")
          output = { deleted: true, flow_id: args.planId };
        else if (kind === "execute_flow" || kind === "execute_api")
          output = nativeRunResult(
            args.projectId,
            output,
            kind === "execute_api" ? "api" : "flow",
          );
        else if (kind === "get_execution_result") {
          assertNativeLinearResult(output);
          output = {
            run: {
              ...output,
              run_id: output.id,
              project_id: args.projectId,
              workbench_evidence_format: 1,
            },
          };
        }
      }
      return result({
        content: [{ type: "text", text: JSON.stringify(output) }],
      });
    } catch (e) {
      const outcome = publicProjectCommitOutcome(e);
      if (outcome.project_ids)
        outcome.project_ids = outcome.project_ids.filter((id) =>
          allowed.has(id),
        );
      const message = projectInterchange
        ? typeof e.message === "string"
          ? e.message.slice(0, 2048)
          : "项目导入导出失败"
        : e.message;
      return result({
        isError: true,
        content: [
          {
            type: "text",
            text:
              params.name === "localapi_get_execution_result_chunk"
                ? executionResultChunkError(e)
                : Object.keys(outcome).length
                  ? JSON.stringify({ error: message, ...outcome })
                  : message,
          },
        ],
      });
    } finally {
      unlockPlan?.();
    }
  };
}
const isStdioEntrypoint = () => {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
};
if (isStdioEntrypoint()) {
  let context;
  try {
    const { createMCPStdioContext } = await import("./mcp-stdio-bootstrap.mjs");
    context = await createMCPStdioContext(
      process.argv.slice(2),
      process.env.LOCAL_API_DATA,
    );
    const { store, projects, write, execute } = context;
    const sessionProjects = [];
    const dispatch = createMCP({
      store,
      projects,
      sessionProjects,
      write,
      execute,
      databaseExecutor: context.databaseExecutor,
    });
    const { serveMCPStdio } = await import("./mcp-stdio.mjs");
    await serveMCPStdio({
      input: process.stdin,
      output: process.stdout,
      dispatch,
      activityFactory: (message) => {
        const args = message.params?.arguments || {};
        const projectId = args.projectId ?? args.project_id;
        if (
          !execute ||
          !write ||
          ![...projects, ...sessionProjects].includes(projectId)
        )
          return undefined;
        return new MCPActivity(store.root, {
          tool: message.params.name,
          projectId,
          planId: args.planId ?? args.flow_id,
        });
      },
    });
  } catch {
    process.stderr.write(
      "MCP stdio startup/transport failed; no input or credentials echoed.\n",
    );
    process.exitCode = 1;
  } finally {
    context?.close();
  }
}
