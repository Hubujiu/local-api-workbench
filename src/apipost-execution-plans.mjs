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
  if (!object(x) || Object.keys(x).some((k) => !allowed.includes(k)))
    throw Error("原版执行计划包含未知字段");
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
  let total = 0;
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
    ]);
    if (
      !identifier(flow.flow_id) ||
      flow.project_id !== source.project_id ||
      !["manual", "ai"].includes(flow.source) ||
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
    const steps = flow.steps.map((step) => {
      fields(step, [
        "api_snapshot",
        "input",
        "step_id",
        "target_id",
        "pre_script",
        "post_script",
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
        fields(step.input, ["body", "query", "path", "headers", "cookies"]);
      // Reuse the established converter with the frozen API and original folders,
      // not the live API record with the same target ID.
      const converted = importModernApipost(
        {
          ...source,
          apis: [
            ...source.apis.filter((n) => n.target_type === "folder"),
            structuredClone(step.api_snapshot),
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
      request = applyMCPInput(request, step.input);
      // The original flow entry skips API pre/post tasks. Preserve their source
      // provenance, but do not silently activate them in a migrated plan.
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
        "原版执行计划跳过接口前后置操作；原接口脚本仅保留来源，不执行；步骤自身的显式脚本独立执行。请核对所选环境的当前值；目录可能仅保存初始值。",
      ];

      if (step.input && Object.hasOwn(step.input, "body")) {
        if (request.bodyType !== "json")
          throw Error("原版计划输入目前仅验证JSON正文");
        request.body = JSON.stringify(step.input.body, null, 2);
      }
      functions = converted.metadata?.settings?.functions || [];
      const key = createHash("sha256")
        .update(flow.flow_id + "\0" + step.step_id)
        .digest("hex");
      return {
        id: resource("flow-step", key),
        name: request.name,
        enabled: true,
        request,
      };
    });
    return snapshotPlan({
      id: planId,
      name: flow.name,
      description: flow.description,
      environmentId: resource("env", flow.environment_id),
      source: flow.source,
      createdAt: flow.created_at,
      updatedAt: flow.updated_at,
      statusPolicy: "strict200",
      functions,
      steps,
    });
  });
}
