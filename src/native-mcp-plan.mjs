import { hasRepeatSteps } from "./plan-repeat.mjs";
export function assertNativeLinearPlan(plan) {
  if (hasRepeatSteps(plan?.steps))
    throw Error("原版兼容流程不支持canonical循环组；请使用canonical计划工具");
}
import { assertNativeInheritanceMCPInput } from "./native-inheritance.mjs";
import { resolveNativeEnvironment } from "./native-mcp-environments.mjs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { applyMCPInput } from "./mcp-request-input.mjs";
import { freezeServiceBinding, selectedEnvironment } from "./environments.mjs";
import { snapshotInterfaceForPlan } from "../public/plan-snapshots.js";
const own = (o, k) => Object.hasOwn(o, k);
function plain(v, keys, label) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(v)) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    throw Error(label + "字段无效");
}
function script(v) {
  if (typeof v !== "string" || Buffer.byteLength(v) > 65536)
    throw Error("计划步骤脚本必须为最多64KiB文本");
  return v;
}
function stripTasks(r) {
  const copy = snapshotInterfaceForPlan(r);
  delete copy.nativeTasks;
  delete copy.importedScriptTasks;
  delete copy.importedNativeTaskSource;
  copy.assertions = [];
  copy.extract = [];
  return copy;
}
export function inputAuth(base, input) {
  if (input === undefined) return {};
  const next = structuredClone(input);
  if (!next.auth) return next;
  const a = next.auth,
    type = base.auth?.type || "none";
  const provider = {
    none: "noauth",
    basic: "basic",
    bearer: "bearer",
    apiKey: "kv",
  }[type];
  if (!provider)
    throw Error("原版兼容计划暂不支持此认证覆盖；请用Workbench计划接口");
  plain(a, ["type", provider], "认证覆盖");
  if (a.type !== undefined && a.type !== provider)
    throw Error("不能改变认证类型");
  const fields = {
    basic: { username: "username", password: "password" },
    bearer: { key: "token" },
    kv: { key: "key", value: "value", in: "in" },
    noauth: {},
  }[provider];
  const patch = a[provider] || {};
  plain(patch, Object.keys(fields), "认证覆盖");
  next.auth = Object.fromEntries(
    Object.entries(patch).map(([key, value]) => [fields[key], value]),
  );
  return next;
}
function materialize(state) {
  const request = applyMCPInput(
    state.baseRequest,
    inputAuth(state.baseRequest, state.input),
  );
  return {
    ...request,
    scriptDialect: "apipost8",
    beforeScript: state.preScript,
    afterScript: state.postScript,
    inheritSharedScripts: false,
    sharedBeforeScripts: [],
    sharedAfterScripts: [],
    sharedScriptsSnapshot: true,
  };
}
export function normalizeNativeMCPState(
  value,
  request,
  normalizeRequest,
  budget,
) {
  if (value === undefined) return undefined;
  plain(
    value,
    ["version", "targetId", "baseRequest", "input", "preScript", "postScript"],
    "原版MCP步骤来源",
  );
  if (
    value.version !== 1 ||
    typeof value.targetId !== "string" ||
    !value.targetId
  )
    throw Error("原版MCP步骤来源版本或接口标识无效");
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024)
    throw Error("原版MCP步骤来源超过2MiB");
  if (budget) {
    budget.bytes +=
      Buffer.byteLength(JSON.stringify(value)) +
      Buffer.byteLength(JSON.stringify(request));
    if (budget.bytes > 4 * 1024 * 1024)
      throw Error("原版MCP计划展开快照超过4MiB");
  }
  if (
    value.baseRequest?.nativeTasks ||
    value.baseRequest?.importedScriptTasks ||
    value.baseRequest?.importedNativeTaskSource !== undefined
  )
    throw Error("原版MCP基础快照不能携带接口任务");
  const base = normalizeRequest(value.baseRequest);
  if (
    base.id !== value.targetId ||
    base.beforeScript ||
    base.afterScript ||
    base.before.length ||
    base.after.length ||
    base.assertions.length ||
    base.extract.length ||
    base.nativeTasks ||
    base.importedScriptTasks ||
    base.importedNativeTaskSource !== undefined ||
    base.sharedBeforeScripts.length ||
    base.sharedAfterScripts.length
  )
    throw Error("原版MCP基础快照不能执行接口任务");
  const state = {
    version: 1,
    targetId: value.targetId,
    baseRequest: base,
    input: structuredClone(value.input),
    preScript: script(value.preScript),
    postScript: script(value.postScript),
  };
  const expected = normalizeRequest(materialize(state));
  if (!isDeepStrictEqual(expected, normalizeRequest(request)))
    throw Error("原版MCP步骤来源与执行快照不一致");
  return state;
}
export function buildNativeMCPPlan(project, args, previous, normalizeRequest) {
  assertNativeLinearPlan(previous);
  const update = Boolean(previous);
  const name = own(args, "name") ? args.name : previous?.name;
  if (typeof name !== "string" || !name.trim() || name.length > 200)
    throw Error("计划名称不能为空且最多200字符");
  const description = own(args, "description")
    ? args.description
    : previous?.description || "";
  if (typeof description !== "string" || description.length > 10000)
    throw Error("计划说明无效");
  const environmentId = own(args, "environment_id")
    ? resolveNativeEnvironment(project, args.environment_id).id
    : previous?.environmentId || selectedEnvironment(project).id;
  const source = own(args, "steps") ? args.steps : null;
  if (
    source !== null &&
    (!Array.isArray(source) || !source.length || source.length > 200)
  )
    throw Error("原版兼容计划必须包含1至200步");
  if (!update && source === null) throw Error("缺少计划步骤");
  const budget = { bytes: 0 };
  const seen = new Set();
  const steps =
    source === null
      ? structuredClone(previous.steps)
      : source.map((item) => {
          plain(
            item,
            ["target_id", "step_id", "input", "pre_script", "post_script"],
            "计划步骤",
          );
          if (typeof item.target_id !== "string" || !item.target_id)
            throw Error("每步须引用当前项目接口ID");
          const api = project.requests.find(
            (r) => r.id === item.target_id && !r.deletedAt,
          );
          if (!api) throw Error("步骤接口不存在或不属于当前项目");
          if (
            own(item, "step_id") &&
            (typeof item.step_id !== "string" || !item.step_id)
          )
            throw Error("步骤ID无效");
          const old = item.step_id
            ? previous?.steps.find((s) => s.id === item.step_id)
            : undefined;
          if (item.step_id && (!old || !update))
            throw Error("旧步骤ID不存在；新步骤不要指定ID");
          const stepId = old?.id || randomUUID();
          if (seen.has(stepId)) throw Error("步骤ID重复");
          seen.add(stepId);
          if (
            old &&
            (!old.nativeMCP || old.nativeMCP.targetId !== item.target_id)
          )
            throw Error("不能更换已有步骤接口或编辑非兼容步骤");
          const baseRequest = old
            ? structuredClone(old.nativeMCP.baseRequest)
            : normalizeRequest(
                stripTasks(
                  freezeServiceBinding(project, api, {
                    includeSharedScripts: false,
                  }),
                ),
              );
          const state = {
            version: 1,
            targetId: item.target_id,
            baseRequest,
            input: own(item, "input")
              ? structuredClone(item.input)
              : structuredClone(old?.nativeMCP.input || {}),
            preScript: own(item, "pre_script")
              ? script(item.pre_script)
              : old?.nativeMCP.preScript || "",
            postScript: own(item, "post_script")
              ? script(item.post_script)
              : old?.nativeMCP.postScript || "",
          };
          assertNativeInheritanceMCPInput(
            project,
            api,
            baseRequest,
            inputAuth(baseRequest, state.input),
          );
          const request = normalizeRequest(materialize(state));
          return {
            id: stepId,
            name: old?.name || api.name,
            enabled: old?.enabled !== false,
            request,
            nativeMCP: normalizeNativeMCPState(
              state,
              request,
              normalizeRequest,
              budget,
            ),
          };
        });
  return {
    id: previous?.id || randomUUID(),
    name,
    description,
    environmentId,
    steps,
    statusPolicy: "strict200",
    createdAt: previous?.createdAt,
    functions: structuredClone(
      previous?.functions || project.settings?.functions || [],
    ),
  };
}
export function nativeFlowView(projectId, plan) {
  assertNativeLinearPlan(plan);
  return {
    flow_id: plan.id,
    project_id: projectId,
    name: plan.name,
    description: plan.description,
    environment_id: plan.environmentId,
    source: plan.source === "ai" ? "mcp" : "manual",
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
    steps: plan.steps.map((s) => ({
      step_id: s.id,
      target_id: s.nativeMCP?.targetId || s.request?.id,
      api_snapshot: structuredClone(s.nativeMCP?.baseRequest || s.request),
      input: structuredClone(s.nativeMCP?.input || {}),
      pre_script: s.nativeMCP?.preScript || s.request?.beforeScript || "",
      post_script: s.nativeMCP?.postScript || s.request?.afterScript || "",
    })),
    workbench_snapshot_format: 1,
  };
}
