import { projectWithoutLoadRuns } from "./project-owner-projection.mjs";
import { environmentTextRequired } from "./postman-environment-import.mjs";
import { materializeLivePlan } from "./live-plan-materialize.mjs";
import {
  scopedExportArguments,
  previewDefinitionExport,
  exportDefinitionSelection,
  scopedExportMCPResult,
  scopedExportErrorMessage,
} from "./scoped-definition-export.mjs";
import {
  listRequestDefinitionHistory,
  getRequestDefinitionVersion,
  projectHistoryProjection,
} from "./request-definition-history.mjs";
import { failureStopSummary } from "./plan-failure-policy.mjs";
import { publishDebugVariables } from "./debug-publication.mjs";
import { conditionSummary } from "./execution-history.mjs";
import {
  activePlanStepCount,
  hasPlanConditions,
  hasRuntimeRows,
  potentialPlanStepCount,
} from "./plan-repeat.mjs";
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
import { types } from "node:util";
import {
  importedExecutionChunkArguments,
  importedExecutionChunkDefaultBytes,
  importedExecutionChunkMaxBytes,
  importedExecutionChunkError,
} from "./imported-execution-chunk.mjs";
import { executeWireFlow } from "./wire-plan.mjs";
import { executeSocketIOFlow } from "./socketio-plan.mjs";
import { SocketIOSessions } from "./socketio.mjs";
import { recordPlanRun } from "./plan-evidence.mjs";
import { executeGrpc } from "./grpc.mjs";
import { grpcSource } from "./grpc-schema.mjs";
import { generateGrpcRequestExample } from "./grpc-request-example.mjs";
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
  debugEnvironmentFingerprint,
} from "./environments.mjs";
import {
  environmentTools,
  isEnvironmentTool,
  executeEnvironmentTool,
} from "./mcp-environments.mjs";
export const REQUEST_DEFINITION_HISTORY_MCP_MAX_BYTES = 2 * 1024 * 1024;
export function requestDefinitionHistoryMCPJSON(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > REQUEST_DEFINITION_HISTORY_MCP_MAX_BYTES)
    throw Error("接口定义历史结果超过 2 MiB；请使用本地项目备份读取完整定义");
  return text;
}

// Validate only the transport envelope here. The Store owns the shared nested
// input contract and its budgets; history/interchange limits do not apply.
function manualImportMCPArguments(value, apply) {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("手动导入参数必须为普通对象");
  const fields = apply
    ? ["projectId", "token", "input"]
    : ["projectId", "input"];
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => !fields.includes(key))
  )
    throw Error("手动导入参数字段缺失或含未知字段");
  const args = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw Error("手动导入参数必须为普通数据");
    args[key] = descriptor.value;
  }
  return args;
}
const manualImportErrorCodes = new Set([
  "MANUAL_IMPORT_INVALID",
  "MANUAL_IMPORT_ABORTED",
  "MANUAL_IMPORT_INPUT_INVALID",
  "MANUAL_IMPORT_ENVIRONMENT_TEXT_REQUIRED",
  "MANUAL_IMPORT_CONFLICT",
  "MANUAL_IMPORT_PLAN_INVALID",
  "MANUAL_IMPORT_RESOURCE_CONFLICT",
  "MANUAL_IMPORT_TARGET_UNSUPPORTED",
  "MANUAL_IMPORT_SELECTION_INVALID",
  "MANUAL_IMPORT_DEPENDENCY_EXCLUDED",
  "MANUAL_IMPORT_DEPENDENCY_MISSING",
  "MANUAL_IMPORT_FOLDER_MAP_INVALID",
  "MANUAL_IMPORT_CLEAR_SCOPE_INVALID",
  "MANUAL_IMPORT_CLEAR_SELECTION_EMPTY",
]);

// Confirmation is transport-only. The Store receives only the exact mutation
// contract and owns the configuration conflict check and abort-before-commit gate.
export function requestDefinitionHistoryChangeInput(input) {
  const options = projectHistoryProjection(input, { maxBytes: 128 * 1024 });
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw Error("接口定义历史操作必须为对象");
  const required = ["kind", "requestId", "lineageId", "configRevision"];
  let optional = [];
  if (options.kind === "tag") required.push("historyId", "tag");
  else if (options.kind === "restore") required.push("historyId");
  else if (options.kind === "clear") {
    required.push("confirm");
    optional = ["historyIds", "all"];
  } else throw Error("接口定义历史操作类型无效");
  if (
    required.some((key) => !Object.hasOwn(options, key)) ||
    Object.keys(options).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw Error("接口定义历史操作字段缺失或含未知字段");
  if (
    !Number.isSafeInteger(options.configRevision) ||
    options.configRevision < 0
  )
    throw Error("接口定义历史操作必须提供有效 configRevision");
  if (options.kind === "clear") {
    if (options.confirm !== true)
      throw Error("清理接口定义历史必须显式传入 confirm: true");
    delete options.confirm;
  }
  return options;
}

export function requestDefinitionHistoryChangeResult(project, input) {
  const entry = project.requestDefinitionHistory?.entries.find(
    (item) =>
      item.requestId === input.requestId && item.lineageId === input.lineageId,
  );
  return {
    projectId: project.id,
    revision: project.revision,
    configRevision: project.configRevision,
    kind: input.kind,
    requestId: input.requestId,
    lineageId: input.lineageId,
    ...(Object.hasOwn(input, "historyId")
      ? { historyId: input.historyId }
      : {}),
    ...(input.kind === "tag" ? { tag: input.tag } : {}),
    ...(input.kind === "clear"
      ? input.all === true
        ? { all: true }
        : { historyIds: [...input.historyIds] }
      : {}),
    remainingHistory: entry?.versions.length ?? 0,
    lineageRemoved: !entry,
  };
}

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
  databasePreflight,
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
            "保存独立快照计划；failurePolicy可选stop以在普通失败后停止整计划，默认continue且不回滚副作用；repeat支持HTTP/gRPC/Socket.IO/TCP/WebSocket/SSE且count为1至100，可选intervalMs为0至10000毫秒，整图潜在等待最多60000毫秒；repeat可选untilCondition在每轮后判断，达到count仍不满足则失败，同组不支持rows且后代仅HTTP/TCP/WebSocket/gRPC/Socket.IO。if支持HTTP/gRPC/Socket.IO/TCP/WebSocket/SSE及if/repeat子组，condition为{op,left,right}，op限eq/neq/gt/gte/lt/lte/contains/notContains，operand为{literal}或{scope:globals/environment/runtime/iterationData,name}，contains/notContains仅比较非空文本且区分大小写，不隐式转换；iterationData仅限数据行循环后代的顶层字段。共同最多4层、含禁用节点最多200潜在请求及200次条件判断",
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
  const manualImportInput = {
    type: "object",
    description:
      "内联导入输入；必须提供 format、document、selection。支持 policies、folderMap、bindings、options、clearScope；不接受路径或 URL，不执行请求",
    properties: {
      format: {
        type: "string",
        enum: ["auto", "apipost", "apipost-directory", "openapi"],
      },
      document: { oneOf: [{ type: "object" }, { type: "string" }] },
      selection: {
        oneOf: [
          {
            type: "object",
            properties: { mode: { type: "string", const: "all" } },
            required: ["mode"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              mode: { type: "string", const: "explicit" },
              keys: { type: "array", items: str, uniqueItems: true },
              exclude: { type: "array", items: str, uniqueItems: true },
            },
            required: ["mode", "keys"],
            additionalProperties: false,
          },
        ],
      },
      policies: {
        type: "object",
        properties: {
          api: {
            type: "string",
            enum: ["both", "ignore", "url", "url_and_folder", "clear"],
          },
          samples: { type: "string", enum: ["both", "name"] },
          models: { type: "string", enum: ["both", "name"] },
          environments: { type: "string", const: "both" },
          documents: { type: "string", const: "both" },
          globals: { type: "string", const: "safe" },
        },
        additionalProperties: false,
      },
      folderMap: { type: "object", additionalProperties: str },
      bindings: { type: "object", additionalProperties: str },
      options: {
        type: "object",
        properties: {
          modelNameMode: { type: "string", enum: ["namespaced", "preserve"] },
          postmanVariableMode: {
            type: "string",
            enum: ["environment", "collection"],
          },
        },
        additionalProperties: false,
      },
      clearScope: {
        type: "object",
        properties: { folder: str },
        required: ["folder"],
        additionalProperties: false,
      },
    },
    required: ["format", "document", "selection"],
    additionalProperties: false,
  };
  addTool(
    "preview_import",
    "预览已授权项目的手动资源导入；需要有效会话，不修改项目、不执行请求",
    { ...projectArg, input: manualImportInput },
  );
  if (write)
    addTool(
      "apply_import",
      "应用同一会话、来源与项目配置的导入预览；需要当前写入授权，不执行请求",
      {
        ...projectArg,
        token: { type: "string", maxLength: 4096 },
        input: manualImportInput,
      },
    );
  addTool(
    "list_api_definition_history",
    "读取接口定义版本摘要及血缘，不包含定义正文，不执行请求",
    {
      ...projectArg,
      requestId: str,
      lineageId: str,
      offset: { type: "integer", minimum: 0, maximum: 10000 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      lineageOffset: { type: "integer", minimum: 0, maximum: 10000 },
      lineageLimit: { type: "integer", minimum: 1, maximum: 100 },
    },
    ["projectId", "requestId"],
  );
  addTool(
    "get_api_definition_version",
    "读取指定接口定义版本；最多 2 MiB JSON，可能包含已保存的凭据，不执行请求",
    { ...projectArg, requestId: str, lineageId: str, historyId: str },
    ["projectId", "requestId", "historyId"],
  );
  if (write) {
    const target = {
      ...projectArg,
      requestId: str,
      lineageId: str,
      configRevision: { type: "integer", minimum: 0 },
    };
    addTool(
      "tag_api_definition_version",
      "修改指定接口定义版本标签；需要当前 configRevision，不执行请求",
      { ...target, historyId: str, tag: { type: "string", maxLength: 200 } },
    );
    addTool(
      "restore_api_definition",
      "恢复活动血缘的接口定义并保留原当前版本；需要当前 configRevision，不执行请求",
      { ...target, historyId: str },
    );
    addTool(
      "clear_api_definition_history",
      "清理指定血缘的历史版本，保留当前接口；必须 confirm: true 与当前 configRevision，不执行请求",
      {
        ...target,
        historyIds: {
          type: "array",
          items: str,
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
        },
        all: { type: "boolean", const: true },
        confirm: { type: "boolean", const: true },
      },
      [...Object.keys(target), "confirm"],
    );
  }
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
  const scopedResource = {
    type: "object",
    required: ["kind", "id"],
    additionalProperties: false,
    properties: {
      kind: {
        type: "string",
        enum: [
          "api",
          "document",
          "folder",
          "case",
          "case-folder",
          "model",
          "model-folder",
          "environment",
          "globals",
          "protocol-bundle",
          "collection-bundle",
        ],
      },
      id: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description:
          "持久化资源ID；folder为完整路径。固定bundle：globals=configuration，protocol-bundle=definitions，collection-bundle=registry。",
      },
    },
  };
  const scopedResources = {
    type: "array",
    maxItems: 10000,
    uniqueItems: true,
    items: scopedResource,
  };
  for (const exporting of [false, true])
    addTool(
      exporting ? "export_project_selection" : "preview_project_export",
      exporting
        ? "导出明确选择并确认依赖的原生定义；可能含静态凭据，不执行请求"
        : "预览原生定义选择、必需依赖及大小，不返回定义或凭据",
      {
        ...projectArg,
        format: projectFormat,
        selection: {
          type: "object",
          description:
            "明确 all 或非空 explicit 资源选择；完整目录子树不可排除内部叶。不是备份，不读取文件或URL。",
          oneOf: [
            {
              type: "object",
              required: ["mode"],
              additionalProperties: false,
              properties: { mode: { const: "all" } },
            },
            {
              type: "object",
              required: ["mode", "resources"],
              additionalProperties: false,
              properties: {
                mode: { const: "explicit" },
                resources: { ...scopedResources, minItems: 1 },
                exclude: scopedResources,
              },
            },
          ],
        },
        modelNameMode: { type: "string", enum: ["namespaced", "preserve"] },
        databaseMode: { type: "string", enum: ["rebind"] },
        ...(exporting
          ? {
              configRevision: { type: "integer", minimum: 0 },
              scopeDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
              acceptedDependencies: {
                type: "array",
                maxItems: 10000,
                items: {
                  type: "object",
                  required: ["kind", "id"],
                  additionalProperties: false,
                  properties: {
                    kind: { type: "string" },
                    id: { type: "string" },
                  },
                },
              },
            }
          : {}),
      },
      [
        "projectId",
        "format",
        "selection",
        ...(exporting
          ? ["configRevision", "scopeDigest", "acceptedDependencies"]
          : []),
      ],
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
    "generate_grpc_request_example",
    "从已授权项目的 gRPC 定义生成请求示例，不连接远端",
    {
      ...projectArg,
      definitionId: str,
    },
  );
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
      chunk: {
        type: "object",
        description:
          "可选读取原始JSON文件UTF-8字节；后续块须回传首块artifactSha256，不授予新权限",
        properties: {
          offsetBytes: {
            type: "integer",
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
          },
          maxBytes: {
            type: "integer",
            minimum: 1,
            maximum: importedExecutionChunkMaxBytes,
            default: importedExecutionChunkDefaultBytes,
          },
          expectedArtifactSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
        required: ["offsetBytes"],
        additionalProperties: false,
      },
    },
    ["projectId", "sourceProjectId", "runId"],
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
    {
      signal,
      onProgress: emitProgress = onProgress,
      manualImportSessionId,
    } = {},
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
    // Bounded interchange/history tools cannot echo an unbounded/structured ID
    // even in their error envelope. Other tools retain their existing contract.
    const definitionHistory = [
      "localapi_list_api_definition_history",
      "localapi_get_api_definition_version",
      "localapi_tag_api_definition_version",
      "localapi_restore_api_definition",
      "localapi_clear_api_definition_history",
    ].includes(params?.name);
    const scopedExport = [
      "localapi_preview_project_export",
      "localapi_export_project_selection",
    ].includes(params?.name);
    const projectInterchange = [
      "localapi_import_project",
      "localapi_export_project",
      "localapi_preview_project_export",
      "localapi_export_project_selection",
    ].includes(params?.name);
    const manualImport = [
      "localapi_preview_import",
      "localapi_apply_import",
    ].includes(params?.name);
    if (
      (projectInterchange || definitionHistory || manualImport) &&
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
          message: manualImport
            ? "手动导入请求ID必须为安全整数或最多256字节的字符串"
            : projectInterchange
              ? "项目导入导出请求ID必须为安全整数或最多256字节的字符串"
              : "接口定义历史请求ID必须为安全整数或最多256字节的字符串",
        },
      };
    let importedChunkRequest = false;
    try {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) throw Error("工具不存在或未授权");
      let args = params.arguments === undefined ? {} : params.arguments;
      if (manualImport) {
        args = manualImportMCPArguments(
          args,
          params.name === "localapi_apply_import",
        );
        // This identity is injected by the transport, never by client arguments.
        if (
          typeof manualImportSessionId !== "string" ||
          !manualImportSessionId ||
          Buffer.byteLength(manualImportSessionId) > 1024
        )
          throw Error("手动导入需要有效 MCP 会话");
        signal?.throwIfAborted();
      }
      if (params.name === "localapi_get_execution_result_chunk")
        args = executionResultChunkArguments(args);
      if (tool.name === "localapi_get_imported_execution_run") {
        importedChunkRequest = true;
        const chunkArgs = importedExecutionChunkArguments(args);
        importedChunkRequest = chunkArgs !== null;
        if (chunkArgs) args = chunkArgs;
      }
      if (scopedExport)
        args = scopedExportArguments(args, {
          exporting: params.name === "localapi_export_project_selection",
          mcp: true,
        });
      if (definitionHistory)
        args = projectHistoryProjection(args, { maxBytes: 128 * 1024 });
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
        if (scopedExport) signal?.throwIfAborted();
        const p = await store.get(args.projectId);
        if (scopedExport) signal?.throwIfAborted();
        if (!scopedExport && p.archived) throw Error("项目已归档");
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
            case "localapi_preview_import":
              output = await store.previewManualImport(
                args.projectId,
                args.input,
                {
                  sessionId: manualImportSessionId,
                  signal,
                },
              );
              break;
            case "localapi_apply_import":
              if (!write) throw Error("手动导入写入未授权");
              output = await store.applyManualImport(
                args.projectId,
                { token: args.token, input: args.input },
                { sessionId: manualImportSessionId, signal },
              );
              break;
            case "localapi_list_api_definition_history":
            case "localapi_get_api_definition_version": {
              const { projectId, ...input } = args;
              output = {
                projectId,
                revision: p.revision,
                configRevision: p.configRevision,
                ...(params.name === "localapi_list_api_definition_history"
                  ? listRequestDefinitionHistory(p, input)
                  : getRequestDefinitionVersion(p, input)),
              };
              break;
            }
            case "localapi_tag_api_definition_version":
            case "localapi_restore_api_definition":
            case "localapi_clear_api_definition_history": {
              // Tool visibility never substitutes for an explicit write grant.
              if (!write) throw Error("接口定义历史写入未授权");
              signal?.throwIfAborted();
              const { projectId, ...input } = args;
              const change = requestDefinitionHistoryChangeInput({
                ...input,
                kind: {
                  localapi_tag_api_definition_version: "tag",
                  localapi_restore_api_definition: "restore",
                  localapi_clear_api_definition_history: "clear",
                }[params.name],
              });
              const saved = await store.changeRequestDefinitionHistory(
                projectId,
                change,
                { signal },
              );
              output = requestDefinitionHistoryChangeResult(saved, change);
              break;
            }
            case "localapi_preview_project_export":
            case "localapi_export_project_selection": {
              signal?.throwIfAborted();
              const { projectId: _projectId, ...input } = args;
              const scoped =
                params.name === "localapi_preview_project_export"
                  ? previewDefinitionExport(p, input, { mcp: true })
                  : exportDefinitionSelection(p, input);
              signal?.throwIfAborted();
              return result(scopedExportMCPResult(scoped, requestId));
            }
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
            case "localapi_generate_grpc_request_example": {
              const definition = (p.settings?.grpcDefinitions || []).find(
                (x) => x.id === args.definitionId,
              );
              if (!definition) throw Error("gRPC定义不存在");
              output = generateGrpcRequestExample({
                ...grpcSource(definition),
                service: definition.service,
                method: definition.method,
              });
              break;
            }
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
                  ({
                    id,
                    planName,
                    status,
                    createdAt,
                    planHash,
                    stopReason,
                    conditionResults,
                    untilLimit,
                    failureStop,
                  }) => ({
                    id,
                    planName,
                    status,
                    createdAt,
                    planHash,
                    ...(stopReason ? { stopReason } : {}),
                    ...conditionSummary({
                      conditionResults,
                      stopReason,
                      untilLimit,
                    }),
                    ...failureStopSummary({ stopReason, failureStop }),
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
                importedChunkRequest ? args.chunk : undefined,
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
                let operation = {
                  type: "recycle-requests",
                  requestIds: args.apiIds,
                };
                if (
                  nativeName &&
                  args.apiIds.length === 1 &&
                  typeof args.apiIds[0] === "string" &&
                  args.apiIds[0].startsWith("folder:")
                ) {
                  const folder = p.settings.nativeInheritance.folders.find(
                    (item) => item.path === args.apiIds[0].slice(7),
                  );
                  if (!folder) throw Error("目录不属于当前继承图");
                  operation = {
                    type: "recycle-folder",
                    sourceId: folder.sourceId,
                  };
                }
                await store.editNativeInheritance(
                  p.id,
                  {
                    configRevision: p.configRevision,
                    operation,
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
              if (nativeName) assertNativeLinearPlan(plan);
              const context = debugEnvironment(
                p,
                environmentId,
                debugEnvironments,
                request.postmanCollectionId,
              );
              output = await runPlan(plan, context.variables, executeRequest, {
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
                  context.variables,
                  request.postmanCollectionId,
                ),
                onStep: (step) =>
                  emitProgress({
                    completed: 1,
                    total: 1,
                    stepId: step.stepId,
                    status: step.status,
                  }),
              });
              if (!signal?.aborted && output.results[0]?.response)
                publishDebugVariables(debugEnvironments, context.publication, {
                  fingerprint: debugEnvironmentFingerprint(
                    p,
                    context.environment.id,
                    request.postmanCollectionId,
                  ),
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
              const definition = p.plans.find((r) => r.id === args.planId);
              if (!definition) throw Error("计划不存在");
              if (nativeName) assertNativeLinearPlan(definition);
              const { plan, bindings } = materializeLivePlan(p, definition, {
                allowRuntimeRows: !nativeName,
              });
              // Even disabled runtime groups need the opt-in graph counter;
              // activePlanStepCount intentionally rejects that definition shape.
              const runtimeRows = hasRuntimeRows(plan.steps);
              const totalIsPotential =
                runtimeRows || hasPlanConditions(plan.steps);
              const totalSteps = runtimeRows
                ? potentialPlanStepCount(plan, { allowRuntimeRows: true })
                : activePlanStepCount(plan);
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
                  allowRuntimeRows: !nativeName,
                  databasePreflight: databasePreflight
                    ? (ids, signal) => databasePreflight(p.id, ids, signal)
                    : undefined,
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
                      ...(totalIsPotential ? { totalIsPotential: true } : {}),
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
              if (output.conditionResults || runtimeRows) {
                try {
                  await emitProgress({
                    completed: output.results.length,
                    total: totalSteps,
                    totalIsPotential: true,
                    finished: true,
                    status: output.status,
                    ...(output.conditionResults
                      ? { conditions: output.conditionResults.length }
                      : {}),
                  });
                } catch {
                  // Reporting is not execution. Preserve completed leaf/decision
                  // evidence and save the reporting failure without replay.
                  if (output.status !== "cancelled") output.status = "failed";
                  output.stopReason ||= "progress-failure";
                  output.progressFailure = {
                    code: "EXECUTION_PROGRESS_FAILED",
                    message:
                      "Execution stopped because progress reporting failed; inspect saved results, do not replay.",
                    retry_safe: false,
                  };
                }
                // Cancellation may arrive while the reporter settles, after
                // runPlan has already returned its completed leaf evidence.
                if (signal?.aborted) output.status = "cancelled";
              }
              output.environmentId = environmentId;
              if (bindings.length) output.liveBindings = bindings;
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
        content: [
          {
            type: "text",
            text: definitionHistory
              ? requestDefinitionHistoryMCPJSON(output)
              : JSON.stringify(projectWithoutLoadRuns(output)),
          },
        ],
      });
    } catch (e) {
      // Archive chunks use a fixed error even for hostile injected Store
      // failures. Do not inspect error properties before this boundary.
      if (importedChunkRequest)
        return result({
          isError: true,
          content: [{ type: "text", text: importedExecutionChunkError }],
        });
      if (scopedExport)
        return result({
          isError: true,
          content: [{ type: "text", text: scopedExportErrorMessage(e) }],
        });
      const outcome = publicProjectCommitOutcome(e);
      if (outcome.project_ids)
        outcome.project_ids = outcome.project_ids.filter((id) =>
          allowed.has(id),
        );
      const message = manualImport
        ? Object.keys(outcome).length
          ? "手动导入提交结果不确定；请恢复并读取现有项目，不要自动重试"
          : e?.code === "MANUAL_IMPORT_ENVIRONMENT_TEXT_REQUIRED"
            ? environmentTextRequired().message
            : "手动导入失败；请检查当前授权、有效会话与输入，并重新预览"
        : projectInterchange
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
                : manualImport
                  ? JSON.stringify({
                      error: message,
                      ...(Object.keys(outcome).length
                        ? outcome
                        : {
                            code: manualImportErrorCodes.has(e?.code)
                              ? e.code
                              : "MANUAL_IMPORT_INVALID",
                          }),
                    })
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
      databasePreflight: context.databasePreflight,
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
