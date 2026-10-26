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
  const converted = {};
  for (const [key, value] of Object.entries(args))
    converted[
      {
        project_id: "projectId",
        target_id: "apiId",
        flow_id: "planId",
        run_id: "runId",
        environment_id: "environmentId",
      }[key] || key
    ] = value;
  return { name: "localapi_" + kind, args: converted };
}
const parent = (folder) => (folder ? "folder:" + folder : "0");
export function nativeAPIList(project, args) {
  const folders = new Set(project.folders || []);
  for (const r of [...project.requests, ...(project.documents || [])])
    if (r.folder) {
      const parts = r.folder.split("/");
      parts.forEach((_, i) => folders.add(parts.slice(0, i + 1).join("/")));
    }
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
  const d = (project.documents || []).find(
    (d) => d.id === apiId && !d.deletedAt,
  );
  if (d)
    return {
      api: {
        target_id: d.id,
        project_id: project.id,
        parent_id: parent(d.folder),
        target_type: "doc",
        name: d.title,
        description: d.content,
        builtin_pre_scripts: [],
        builtin_post_scripts: [],
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
export function nativeRunResult(projectId, run) {
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
      }));
  return {
    run_id: run.id,
    project_id: projectId,
    status: run.status,
    scope: "flow",
    elapsed_ms: run.durationMs,
    total: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed,
    record_saved: run.recordSaved,
    ...(run.recordSaved === false
      ? { persistence_error: run.persistenceError }
      : {}),
  };
}
