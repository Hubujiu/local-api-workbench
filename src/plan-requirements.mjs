import { isProxy } from "node:util/types";
import { validatePlanDefinitionTypes } from "./plan-step-types.mjs";
import {
  activePlanLeaves,
  hasRepeatSteps,
  potentialPlanStepCount,
} from "./plan-repeat.mjs";
import { normalizeNativeTaskRequest } from "./script-database-tasks.mjs";

// Inspect only fields used by analysis. Never reflect on a Proxy or evaluate
// an accessor; unrelated legacy metadata retains its historical data contract.
function dataObject(object) {
  if (
    !object ||
    typeof object !== "object" ||
    isProxy(object) ||
    !(
      Array.isArray(object) ? [Array.prototype] : [Object.prototype, null]
    ).includes(Object.getPrototypeOf(object))
  )
    throw Error("计划需求字段须为普通数据，不能包含Proxy");
}
function field(object, key) {
  dataObject(object);
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor && !Object.hasOwn(descriptor, "value"))
    throw Error("计划需求字段不能包含访问器");
  const value = descriptor?.value;
  if (isProxy(value)) throw Error("计划需求字段不能包含Proxy");
  return value;
}
function entries(array) {
  if (isProxy(array) || !Array.isArray(array))
    throw Error("计划需求操作须为普通数组");
  const result = [];
  for (let index = 0; index < field(array, "length"); index++)
    result.push(field(array, String(index)));
  return result;
}
// The native parser reads its complete task payload. Admit that payload only,
// not unrelated request schemas, before allowing the existing parser to read it.
function nativeData(root) {
  const ancestors = new Set();
  let nodes = 0;
  const visit = (value, depth) => {
    if (++nodes > 100000 || depth > 32 || isProxy(value))
      throw Error("计划需求原生任务数据无效或超限");
    if (value === null || typeof value !== "object") {
      if (["function", "symbol", "bigint"].includes(typeof value))
        throw Error("计划需求原生任务须为普通数据");
      return;
    }
    dataObject(value);
    if (ancestors.has(value)) throw Error("计划需求原生任务不能包含循环");
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value))
      visit(field(value, key), depth + 1);
    ancestors.delete(value);
  };
  visit(root, 0);
}

/**
 * Static requirements of active canonical definitions, not executed occurrences.
 * False conditions and runtime sources that will be empty still require grants.
 * This does not resolve variables, run scripts, or infer arbitrary script access.
 * Protocol credentials and DB grants remain the responsibility of their existing
 * validators; a connection ID here is a requirement, never an authorization.
 */
export function analyzePlanRequirements(
  plan,
  { allowRuntimeRows = false } = {},
) {
  validatePlanDefinitionTypes(plan);
  const options = { allowRuntimeRows };
  const repeated = hasRepeatSteps(plan.steps);
  // The strict repeat data validator is not a legacy linear-plan validator:
  // unused metadata there may contain deep schemas, Date objects or NaN.
  // Only control graphs need a multiplicity ceiling and strict repeat admission.
  const leaves = repeated
    ? activePlanLeaves(plan.steps, options)
    : entries(plan.steps).filter((step) => field(step, "enabled") !== false);
  const potentialSteps = repeated
    ? potentialPlanStepCount(plan, options)
    : leaves.length;
  const executors = new Set();
  const connections = new Set();
  const requireDatabase = (connectionId) => {
    // Match the existing CLI declaration collection: IDs are exact, not templates.
    if (typeof connectionId !== "string" || !connectionId)
      throw Error("数据库操作缺少连接标识");
    connections.add(connectionId);
    executors.add("database");
  };
  // Once per active definition, never once per expanded/runtime occurrence.
  for (const step of leaves) {
    const type = field(step, "type") ?? "http";
    executors.add(type);
    if (type !== "http") continue;
    const request = field(step, "request");
    if (!request) continue;
    for (const phase of ["before", "after"])
      for (const operation of entries(field(request, phase) || [])) {
        if (
          field(operation, "type") === "database" &&
          field(operation, "enabled") !== false
        )
          requireDatabase(field(operation, "connectionId"));
      }
    // Reuse the canonical task parser, including its enabled and mixed-format
    // rules. Do not scan customScript text for apparent database calls.
    const source = field(request, "nativeTasks");
    let tasks;
    if (source !== undefined) {
      nativeData(source);
      const input = { nativeTasks: source };
      for (const key of ["inheritSharedScripts", "beforeScript", "afterScript"])
        input[key] = field(request, key);
      for (const key of [
        "before",
        "after",
        "sharedBeforeScripts",
        "sharedAfterScripts",
      ]) {
        const value = field(request, key);
        if (value !== undefined && value !== null)
          input[key] = { length: field(value, "length") };
      }
      tasks = normalizeNativeTaskRequest(input);
    }
    if (tasks)
      for (const phase of ["before", "after"])
        for (const task of tasks[phase])
          if (task.type === "database" && task.enabled === 1)
            requireDatabase(task.data.connectionId);
  }
  return Object.freeze({
    executorTypes: Object.freeze([...executors]),
    databaseConnectionIds: Object.freeze([...connections]),
    potentialSteps,
    activeLeafCount: leaves.length,
  });
}
