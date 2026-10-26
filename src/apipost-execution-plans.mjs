import { normalizeImportedNativeFlowSource } from "./imported-native-flow-source.mjs";
import { normalizeImportedNativeTaskSource } from "./imported-native-task-source.mjs";
import { createHash } from "node:crypto";
import {
  importModernApipost,
  apipostResourceFactory,
} from "./apipost-modern.mjs";
import { applyMCPInput } from "./mcp-request-input.mjs";
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
const identifier = (x) =>
  typeof x === "string" &&
  /^[A-Za-z0-9_-]{1,200}$/.test(x) &&
  !["__proto__", "constructor", "prototype"].includes(x);
function fields(x, allowed) {
  if (
    !object(x) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(x))
  )
    throw Error("原版执行计划须为普通对象");
  const descriptors = Object.getOwnPropertyDescriptors(x);
  if (
    Reflect.ownKeys(x).some(
      (k) =>
        typeof k !== "string" ||
        !allowed.includes(k) ||
        !descriptors[k].enumerable ||
        !Object.hasOwn(descriptors[k], "value"),
    )
  )
    throw Error("原版执行计划包含未知字段或访问器");
}
function stepAuthentication(value) {
  if (
    !object(value) ||
    Buffer.byteLength(JSON.stringify(value), "utf8") > 65536
  )
    throw Error("原版步骤认证必须是最多64KiB的对象");
  const known = [
    "type",
    "asap",
    "awsv4",
    "basic",
    "bearer",
    "digest",
    "edgegrid",
    "hawk",
    "jwt",
    "kv",
    "ntlm",
    "oauth1",
    "oauth2",
  ];
  fields(value, known);
  if (["noauth", "none"].includes(value.type)) return { type: "noauth" };
  const keys =
    value.type === "basic"
      ? ["username", "password"]
      : value.type === "bearer"
        ? ["key"]
        : null;
  if (!keys) throw Error("原版步骤认证目前仅支持显式无需认证、Basic和Bearer");
  const config = value[value.type];
  fields(config, keys);
  if (keys.some((key) => typeof config[key] !== "string"))
    throw Error("原版步骤认证字段必须是字符串");
  return { type: value.type, [value.type]: structuredClone(config) };
}
export function prepareDirectoryPlans(
  source,
  flows,
  project,
  { normalizeRequest, snapshotPlan },
) {
  if (!flows.length) return [];
  if (
    !Array.isArray(project.plans || []) ||
    (project.plans || []).length + flows.length > 200
  )
    throw Error("执行计划数量超过200");
  const resource = apipostResourceFactory(source.project_id),
    planIds = new Set((project.plans || []).map((p) => p.id));
  let total = 0,
    sourceBytes = 0;
  return flows.map((flow) => {
    fields(flow, [
      "created_at",
      "description",
      "environment_id",
      "flow_id",
      "name",
      "project_id",
      "source",
      "steps",
      "updated_at",
      "mcp_name",
      "mcp_description",
      "mcp_environment_id",
    ]);
    if (
      !identifier(flow.flow_id) ||
      flow.project_id !== source.project_id ||
      !["manual", "ai", "mcp"].includes(flow.source) ||
      typeof flow.name !== "string" ||
      !flow.name.trim() ||
      flow.name.length > 200 ||
      typeof flow.description !== "string" ||
      flow.description.length > 10000
    )
      throw Error("原版执行计划元数据无效");
    for (const field of ["created_at", "updated_at"])
      if (
        typeof flow[field] !== "string" ||
        !Number.isFinite(Date.parse(flow[field]))
      )
        throw Error("原版执行计划时间无效");
    if (
      !Object.hasOwn(flow, "environment_id") ||
      typeof flow.environment_id !== "string" ||
      !flow.environment_id ||
      !source.global.envs.some(
        (env) => String(env.env_id) === flow.environment_id,
      )
    )
      throw Error("原版执行计划环境不存在");
    if (!Array.isArray(flow.steps) || (total += flow.steps.length) > 200)
      throw Error("原版计划导入合计最多200步");
    const planId = resource("flow", flow.flow_id);
    if (planIds.has(planId)) throw Error("原版执行计划已存在，请导入新项目");
    planIds.add(planId);
    const stepIds = new Set();
    let functions = [];
    const historySteps = [];
    const steps = flow.steps.map((step) => {
      fields(step, [
        "api_snapshot",
        "input",
        "step_id",
        "target_id",
        "pre_script",
        "post_script",
        "mcp_input",
        "mcp_deleted_body_keys",
      ]);
      for (const key of ["pre_script", "post_script"])
        if (
          step[key] !== undefined &&
          (typeof step[key] !== "string" ||
            Buffer.byteLength(step[key], "utf8") > 65536)
        )
          throw Error("原版步骤专属脚本须为最多64KiB的字符串");
      if (
        !identifier(step.step_id) ||
        stepIds.has(step.step_id) ||
        !identifier(step.target_id) ||
        !object(step.api_snapshot) ||
        step.api_snapshot.target_id !== step.target_id ||
        step.api_snapshot.project_id !== source.project_id ||
        step.api_snapshot.target_type !== "api"
      )
        throw Error("原版执行计划步骤快照身份无效");
      stepIds.add(step.step_id);
      if (step.input !== undefined)
        fields(step.input, [
          "body",
          "query",
          "path",
          "headers",
          "cookies",
          "auth",
        ]);
      const frozenAPI = structuredClone(step.api_snapshot);
      const overrides = structuredClone(step.input);
      if (overrides && Object.hasOwn(overrides, "auth")) {
        frozenAPI.request.auth = stepAuthentication(overrides.auth);
        delete overrides.auth;
      }
      // Reuse the established converter with the frozen API and original folders,
      // not the live API record with the same target ID.
      const converted = importModernApipost(
        {
          ...source,
          apis: [
            ...source.apis.filter((n) => n.target_type === "folder"),
            frozenAPI,
          ],
          samples: [],
        },
        {
          requests: [],
          environments: [],
          servers: [],
          folders: [],
          settings: {},
          documents: [],
          dictionary: [],
          cases: [],
          plans: [],
        },
      );
      if (converted.requests.length !== 1)
        throw Error("原版计划快照转换结果不唯一");
      let request = normalizeRequest(converted.requests[0]);
      const hasBody = overrides && Object.hasOwn(overrides, "body");
      if (hasBody) {
        const mode = frozenAPI.request?.body?.mode;
        const media = {
          plain: "text/plain",
          text: "text/plain",
          raw: "text/plain",
          xml: "application/xml",
          html: "text/html",
          javascript: "application/javascript",
        };
        // Empty native raw/JSON bodies still have an explicit mode. The legacy
        // API converter may collapse them to none; step input must not lose it.
        if (mode === "json") request.bodyType = "json";
        else if (Object.hasOwn(media, mode)) {
          request.bodyType = "raw";
          if (
            !request.headers.some(
              (row) => row.key.toLowerCase() === "content-type",
            )
          )
            request.headers.push({
              key: "Content-Type",
              value: media[mode],
              enabled: true,
            });
        }
        if (
          !["json", "raw", "urlencoded", "form-data"].includes(request.bodyType)
        )
          throw Error("原版步骤正文覆盖类型尚未支持");
      }
      request = applyMCPInput(request, overrides);
      // Native flows skip API tasks. Preserve only normalized inert task provenance,
      // never a raw API snapshot that can contain discarded connection secrets.
      if (request.nativeTasks !== undefined)
        request.importedNativeTaskSource = normalizeImportedNativeTaskSource(
          request.nativeTasks,
        );
      if (request.importedNativeTaskSource !== undefined) {
        sourceBytes += Buffer.byteLength(
          JSON.stringify(request.importedNativeTaskSource),
        );
        if (sourceBytes > 4 * 1024 * 1024)
          throw Error("导入计划任务来源合计最多4MiB");
      }
      delete request.nativeTasks;
      request.assertions = [];
      request.extract = [];
      request.beforeScript = step.pre_script || "";
      request.afterScript = step.post_script || "";
      if (request.beforeScript || request.afterScript)
        request.scriptDialect = "apipost8";
      request.sharedBeforeScripts = [];
      request.sharedAfterScripts = [];
      request.inheritSharedScripts = false;
      request.before = [];
      request.after = [];
      request.importNotes = [
        ...(request.importNotes || []),
        "原版执行计划跳过接口前后置操作；原接口任务仅保留惰性来源，不执行；步骤自身的显式脚本独立执行。请核对所选环境的当前值；目录可能仅保存初始值。",
      ];

      if (hasBody && request.bodyType === "json")
        request.body = JSON.stringify(step.input.body, null, 2);
      functions = converted.metadata?.settings?.functions || [];
      const key = createHash("sha256")
        .update(flow.flow_id + "\0" + step.step_id)
        .digest("hex");
      const importedStepId = resource("flow-step", key);
      historySteps.push({
        sourceStepId: step.step_id,
        importedStepId,
        ...Object.fromEntries(
          ["mcp_input", "mcp_deleted_body_keys"]
            .filter((key) => Object.hasOwn(step, key))
            .map((key) => [key, step[key]]),
        ),
      });
      return {
        id: importedStepId,
        name: request.name,
        enabled: true,
        request,
      };
    });
    // Preserve the prior shape for ordinary manual/AI flows without comparison data.
    const hasNativeHistory =
      flow.source === "mcp" ||
      ["mcp_name", "mcp_description", "mcp_environment_id"].some((key) =>
        Object.hasOwn(flow, key),
      ) ||
      flow.steps.some((step) =>
        ["mcp_input", "mcp_deleted_body_keys"].some((key) =>
          Object.hasOwn(step, key),
        ),
      );
    const importedNativeFlowSource = hasNativeHistory
      ? normalizeImportedNativeFlowSource({
          version: 1,
          source: flow.source,
          sourceProjectId: flow.project_id,
          sourceFlowId: flow.flow_id,
          ...Object.fromEntries(
            ["mcp_name", "mcp_description", "mcp_environment_id"]
              .filter((key) => Object.hasOwn(flow, key))
              .map((key) => [key, flow[key]]),
          ),
          steps: historySteps,
        })
      : undefined;
    if (importedNativeFlowSource !== undefined) {
      sourceBytes += Buffer.byteLength(
        JSON.stringify(importedNativeFlowSource),
      );
      if (sourceBytes > 4 * 1024 * 1024)
        throw Error("导入计划来源合计最多4MiB");
    }
    return snapshotPlan({
      id: planId,
      name: flow.name,
      description: flow.description,
      environmentId: resource("env", flow.environment_id),
      source: flow.source === "mcp" ? "ai" : flow.source,
      importedNativeFlowSource,
      createdAt: flow.created_at,
      updatedAt: flow.updated_at,
      statusPolicy: "strict200",
      functions,
      steps,
    });
  });
}
