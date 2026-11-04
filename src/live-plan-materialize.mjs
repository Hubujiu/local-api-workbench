import { snapshotPlan } from "./core.mjs";
import { freezeServiceBinding } from "./environments.mjs";
import { liveRequestId } from "./live-plan-reference.mjs";
import { mapPlanLeaves, planLeaves } from "./plan-repeat.mjs";
import { isApipostFunctionSource } from "../public/apipost-function-template.js";

const taskFields = [
  "assertions",
  "extract",
  "before",
  "after",
  "beforeScript",
  "afterScript",
  "scriptDialect",
  "scriptURLMode",
  "nativeTasks",
  "importedNativeTaskSource",
  "importedScriptTasks",
  "inheritSharedScripts",
  "sharedBeforeScripts",
  "sharedAfterScripts",
  "sharedScriptsSnapshot",
];
function assertSupportedLiveSource(request) {
  if (request.postmanCollectionId !== undefined)
    throw Error("实时计划暂不支持 Postman collection 作用域");
  const specs = [
    ...Object.values(request.bodyDynamic || {}),
    ...["query", "headers", "path", "cookies", "form"].flatMap((key) =>
      (request[key] || []).map((row) => row.dynamic),
    ),
  ].filter(Boolean);
  if (
    specs.some(
      (spec) =>
        !spec ||
        typeof spec !== "object" ||
        Array.isArray(spec) ||
        !["fixed", "variable", "mock"].includes(spec.source) ||
        isApipostFunctionSource(spec.source) ||
        (spec.functions !== undefined &&
          (!Array.isArray(spec.functions) || spec.functions.length > 0)),
    )
  )
    throw Error("实时计划暂不支持动态加工函数，避免运行中混用函数快照");
}

export function hasLiveReferences(plan) {
  return planLeaves(plan.steps || []).some(
    (step) => liveRequestId(step) !== undefined,
  );
}

// All lookups happen against one already loaded project snapshot before any
// execution. A missing/deleted reference never falls back to the saved template.
export function materializeLivePlan(
  project,
  plan,
  { allowRuntimeRows = false } = {},
) {
  const refs = planLeaves(plan.steps || [])
    .map((step) => ({ step, id: liveRequestId(step) }))
    .filter((item) => item.id !== undefined);
  if (!refs.length) return { plan, bindings: [] };
  // Bound expansion before accumulating repeated live definitions. Count the
  // original graph plus each replacement, conservatively retaining template
  // bytes; this leaves old, non-live plans untouched.
  const maxLiveBytes = 4 * 1024 * 1024;
  let liveBytes = Buffer.byteLength(JSON.stringify(plan));
  if (liveBytes > maxLiveBytes) throw Error("实时计划冻结快照超过 4 MiB");
  const detached = structuredClone(project);
  if (detached.archived) throw Error("项目已归档");
  const bindings = [];
  const steps = mapPlanLeaves(plan.steps, (step) => {
    const id = liveRequestId(step);
    if (id === undefined) return structuredClone(step);
    const matches = (detached.requests || []).filter((item) => item.id === id);
    if (matches.length !== 1 || matches[0].deletedAt)
      throw Error("实时计划引用的接口不存在、已删除或不唯一");
    const source = structuredClone(matches[0]);
    assertSupportedLiveSource(source);
    const fresh = freezeServiceBinding(detached, source, {
      includeSharedScripts: false,
    });
    assertSupportedLiveSource(fresh);
    const template = step.request;
    if (template.postmanCollectionId !== undefined)
      throw Error("实时计划暂不支持 Postman collection 任务作用域");
    const sourceURLMode = fresh.scriptURLMode;
    for (const key of taskFields) {
      delete fresh[key];
      if (Object.hasOwn(template, key))
        fresh[key] = structuredClone(template[key]);
    }
    if (fresh.scriptURLMode !== sourceURLMode) delete fresh.scriptURLRuntime;
    liveBytes += Buffer.byteLength(JSON.stringify(fresh));
    if (liveBytes > maxLiveBytes) throw Error("实时计划冻结快照超过 4 MiB");
    const result = { ...step, request: fresh };
    delete result.liveRequestId;
    bindings.push({ stepId: step.id, requestId: id });
    return result;
  });
  const frozen = snapshotPlan({ ...plan, steps }, { allowRuntimeRows });
  if (Buffer.byteLength(JSON.stringify(frozen)) > maxLiveBytes)
    throw Error("实时计划冻结快照超过 4 MiB");
  return { plan: frozen, bindings };
}
