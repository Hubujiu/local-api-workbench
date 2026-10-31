import { assertNativeHTTPResult } from "./native-mcp-http-shape.mjs";
import { hasRepeatSteps } from "./plan-repeat.mjs";
import { filteredExecutionHistory } from "./execution-history.mjs";
import {
  activeAPIFolders,
  apiResourceTargets,
  folderSettingKeys,
} from "./api-resource-lifecycle.mjs";
import {
  nativeEnvironmentTools,
  isNativeEnvironmentTool,
} from "./native-mcp-environments.mjs";
// Independent, bounded native-input compatibility. Canonical tools remain available.
const str = { type: "string" },
  project = { project_id: str };
const input = {
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
};
const steps = {
  type: "array",
  minItems: 1,
  maxItems: 200,
  items: {
    type: "object",
    properties: {
      target_id: str,
      step_id: str,
      input,
      pre_script: str,
      post_script: str,
    },
    required: ["target_id"],
    additionalProperties: false,
  },
};
const definitions = [
  [
    "sync_openapi",
    {
      ...project,
      openapi: {},
      folder_id: str,
      api_cover_mode: str,
      base_path: { type: "boolean" },
      host_path: { type: "boolean" },
      api_scripts: { type: "array" },
    },
    ["project_id", "openapi"],
    "write",
  ],
  [
    "create_project",
    { name: str, description: str, storage_path: str },
    ["name"],
    "write",
  ],
  [
    "delete_apis",
    {
      ...project,
      target_ids: { type: "array", items: str, minItems: 1, maxItems: 1000 },
      confirm: { type: "boolean", const: true },
    },
    ["project_id", "target_ids", "confirm"],
    "write",
  ],
  [
    "list_execution_runs",
    {
      ...project,
      scope: { type: "string", enum: ["api", "flow"] },
      source: { type: "string", enum: ["manual", "mcp"] },
      status: { type: "string", enum: ["passed", "failed"] },
      flow_id: str,
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    ["project_id"],
    "read",
  ],
  [
    "execute_api",
    { ...project, target_id: str, environment_id: str, input },
    ["project_id", "target_id"],
    "execute",
  ],
  ["list_projects", {}, [], "read"],
  [
    "list_apis",
    { ...project, parent_id: str, keyword: str },
    ["project_id"],
    "read",
  ],
  [
    "get_api_detail",
    { ...project, target_id: str },
    ["project_id", "target_id"],
    "read",
  ],
  ["list_execution_flows", project, ["project_id"], "read"],
  [
    "get_execution_flow",
    { ...project, flow_id: str },
    ["project_id", "flow_id"],
    "read",
  ],
  [
    "get_execution_result",
    { ...project, run_id: str },
    ["project_id", "run_id"],
    "read",
  ],
  [
    "create_execution_flow",
    { ...project, name: str, description: str, environment_id: str, steps },
    ["project_id", "name", "steps"],
    "write",
  ],
  [
    "update_execution_flow",
    {
      ...project,
      flow_id: str,
      name: str,
      description: str,
      environment_id: str,
      steps,
    },
    ["project_id", "flow_id"],
    "write",
  ],
  [
    "delete_execution_flow",
    { ...project, flow_id: str, confirm: { type: "boolean", const: true } },
    ["project_id", "flow_id", "confirm"],
    "write",
  ],
  [
    "execute_flow",
    { ...project, flow_id: str, environment_id: str },
    ["project_id", "flow_id"],
    "execute",
  ],
];
export function nativeMCPTools(write, execute) {
  return [
    ...nativeEnvironmentTools(write),
    ...definitions
      .filter(
        ([, , , level]) =>
          level === "read" || (write && (level !== "execute" || execute)),
      )
      .map(([name, properties, required]) => ({
        name: "apipost_" + name,
        description:
          "有限原版输入兼容：" +
          name +
          "；保留Workbench授权和快照安全策略，嵌套快照使用Workbench格式",
        inputSchema: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
      })),
  ];
}
export function translateNativeCall(name, args) {
  if (!name.startsWith("apipost_")) return null;
  const kind = name.slice(8);
  if (isNativeEnvironmentTool(kind))
    return {
      name: "localapi_" + kind,
      args: { projectId: args.project_id },
      environmentArgs: args,
    };
  if (!definitions.some(([n]) => n === kind)) throw Error("原版工具尚未支持");
  if (kind === "create_execution_flow" || kind === "update_execution_flow")
    return {
      name: "localapi_" + kind,
      args: { projectId: args.project_id },
      planArgs: args,
    };
  if (kind === "sync_openapi") {
    if (
      (args.base_path !== undefined && typeof args.base_path !== "boolean") ||
      (args.host_path !== undefined && typeof args.host_path !== "boolean")
    )
      throw Error("路径选项必须为布尔值");
    if (args.base_path || args.host_path)
      throw Error("原版路径选项尚未支持；请显式使用相对路径");
    let folder = args.folder_id || "0";
    if (folder !== "0" && (!folder.startsWith("folder:") || !folder.slice(7)))
      throw Error("目录ID无效");
    if (args.api_scripts !== undefined && !Array.isArray(args.api_scripts))
      throw Error("api_scripts必须为数组");
    return {
      name: "localapi_sync_openapi",
      args: {
        projectId: args.project_id,
        document: args.openapi,
        folder: folder === "0" ? "" : folder.slice(7),
        coverMode: args.api_cover_mode,
        apiScripts: (args.api_scripts || []).map((x) => {
          if (
            !x ||
            typeof x !== "object" ||
            Array.isArray(x) ||
            Object.keys(x).some(
              (k) =>
                !["method", "url", "pre_script", "post_script"].includes(k),
            )
          )
            throw Error("脚本映射字段无效");
          return {
            method: x.method,
            url: x.url,
            ...(Object.hasOwn(x, "pre_script")
              ? { beforeScript: x.pre_script }
              : {}),
            ...(Object.hasOwn(x, "post_script")
              ? { afterScript: x.post_script }
              : {}),
          };
        }),
      },
    };
  }
  const converted = {};
  for (const [key, value] of Object.entries(args))
    converted[
      {
        project_id: "projectId",
        target_id: "apiId",
        target_ids: "apiIds",
        flow_id: "planId",
        run_id: "runId",
        environment_id: "environmentId",
      }[key] || key
    ] = value;
  return { name: "localapi_" + kind, args: converted };
}
const parent = (folder) => (folder ? "folder:" + folder : "0");
export function nativeAPIList(project, args) {
  apiResourceTargets(project);
  const folders = activeAPIFolders(project);
  let rows = [
    ...[...folders].map((folder) => ({
      target_id: parent(folder),
      parent_id: parent(folder.split("/").slice(0, -1).join("/")),
      target_type: "folder",
      name: folder.split("/").at(-1),
      method: "",
      url: "",
    })),
    ...project.requests
      .filter((r) => !r.deletedAt)
      .map((r) => ({
        target_id: r.id,
        parent_id: parent(r.folder),
        target_type: "api",
        name: r.name,
        method: r.method,
        url: r.url,
      })),
    ...(project.documents || [])
      .filter((d) => !d.deletedAt)
      .map((d) => ({
        target_id: d.id,
        parent_id: parent(d.folder),
        target_type: "doc",
        name: d.title,
        method: "",
        url: "",
      })),
  ];
  rows = rows
    .map((r, i) => ({ ...r, sort: i + 1 }))
    .filter(
      (r) =>
        (args.parent_id === undefined || r.parent_id === args.parent_id) &&
        (!args.keyword ||
          (r.name + " " + r.method + " " + r.url)
            .toLowerCase()
            .includes(args.keyword.toLowerCase())),
    );
  return { apis: rows };
}
export function nativeAPIDetail(project, apiId) {
  const target = apiResourceTargets(project).get(apiId);
  if (!target) throw Error("接口、目录或文档不存在");
  if (target.type === "folder")
    return {
      api: {
        target_id: apiId,
        project_id: project.id,
        parent_id: parent(target.path.split("/").slice(0, -1).join("/")),
        target_type: "folder",
        name: target.path.split("/").at(-1),
        builtin_pre_scripts: [],
        builtin_post_scripts: [],
        workbench_definition_format: 1,
        workbench_folder_settings: Object.fromEntries(
          folderSettingKeys
            .filter((key) =>
              Object.hasOwn(project.settings?.[key] || {}, target.path),
            )
            .map((key) => [
              key,
              structuredClone(project.settings[key][target.path]),
            ]),
        ),
      },
    };
  const d = (project.documents || []).find(
    (d) => d.id === apiId && !d.deletedAt,
  );
  if (d)
    return {
      api: {
        ...structuredClone(d),
        target_id: d.id,
        project_id: project.id,
        parent_id: parent(d.folder),
        target_type: "doc",
        name: d.title,
        description: d.content,
        builtin_pre_scripts: [],
        builtin_post_scripts: [],
        workbench_definition_format: 1,
      },
    };
  const r = project.requests.find((r) => r.id === apiId && !r.deletedAt);
  if (!r) throw Error("接口或文档不存在");
  return {
    api: {
      ...structuredClone(r),
      target_id: r.id,
      project_id: project.id,
      parent_id: parent(r.folder),
      target_type: "api",
      builtin_pre_scripts: r.beforeScript ? [r.beforeScript] : [],
      builtin_post_scripts: r.afterScript ? [r.afterScript] : [],
      workbench_definition_format: 1,
    },
  };
}
export function assertNativeLinearResult(run) {
  if (
    hasRepeatSteps(run.snapshot?.steps) ||
    run.results?.some((result) => result.repeat)
  )
    throw Error("原版兼容结果不支持canonical循环组；请使用canonical结果工具");
  assertNativeHTTPResult(run);
}
export function nativeRunResult(projectId, run, scope = "flow") {
  assertNativeLinearResult(run);
  const results = run.results || [],
    failed = results
      .filter((r) => r.status !== "passed")
      .map((r) => ({
        step_id: r.stepId,
        target_id: r.request?.id,
        name: r.name,
        method: r.request?.method,
        url: r.request?.url,
        status_code: r.response?.status,
        error: r.error || "",
        ...(r.redirectFailure
          ? { workbench_redirect_failure: r.redirectFailure }
          : {}),
        ...(r.scopeCommit ? { scope_commit: r.scopeCommit } : {}),
      }));
  return {
    run_id: run.id,
    project_id: projectId,
    status: run.status,
    scope,
    elapsed_ms: run.durationMs,
    total: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed,
    record_saved: run.recordSaved,
    ...(run.recordId !== undefined ? { record_id: run.recordId } : {}),
    ...(run.attemptedRecordId !== undefined
      ? { attempted_record_id: run.attemptedRecordId }
      : {}),
    ...(run.recordSaved === false
      ? {
          persistence_error: run.persistenceError,
          ...(run.persistenceOutcome
            ? { persistence_outcome: run.persistenceOutcome }
            : {}),
        }
      : {}),
  };
}

export function nativeExecutionHistory(project, args) {
  if (args.source !== undefined && !["manual", "mcp"].includes(args.source))
    throw Error("原版记录来源无效");
  if (args.status !== undefined && !["passed", "failed"].includes(args.status))
    throw Error("原版记录状态无效");
  const rows = filteredExecutionHistory(project, args);
  for (const { record } of rows) assertNativeLinearResult(record);
  return {
    total: rows.length,
    records: rows.slice(0, args.limit ?? 20).map(({ record, scope }) => {
      const results = scope === "api" ? [record] : record.results || [];
      const failed = results.filter((r) => r.status !== "passed");
      const finished = Date.parse(record.createdAt);
      const elapsed =
        Number.isFinite(record.durationMs) && record.durationMs >= 0
          ? record.durationMs
          : undefined;
      return {
        run_id: record.id,
        source: ["manual", "mcp", "cli"].includes(record.source)
          ? record.source
          : "unknown",
        scope,
        ...(scope === "flow"
          ? { flow_id: record.planId, flow_name: record.planName }
          : {}),
        environment_id: record.environmentId,
        status: record.status,
        finished_at: record.createdAt,
        ...(Number.isFinite(finished) &&
        elapsed !== undefined &&
        Number.isFinite(new Date(finished - elapsed).getTime())
          ? { started_at: new Date(finished - elapsed).toISOString() }
          : {}),
        elapsed_ms: elapsed,
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.length,
        failed_steps: failed.map((r) => ({
          step_id: r.stepId,
          name: r.name,
          status: r.status,
        })),
      };
    }),
  };
}
