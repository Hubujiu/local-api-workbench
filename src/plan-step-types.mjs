import { isProxy } from "node:util/types";

const fail = (message) =>
  Object.assign(Error(message), { code: "PLAN_STEP_TYPE_INVALID" });

// Missing/undefined is the historical HTTP spelling. Never infer HTTP from an
// unrecognized discriminator. This baseline has no repeat-group capability.
export function validatePlanStepTypes(steps) {
  if (!Array.isArray(steps) || isProxy(steps) || steps.length > 200)
    throw fail("执行计划步骤类型或集合无效");
  for (let index = 0; index < steps.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(steps, String(index));
    if (!entry || !Object.hasOwn(entry, "value"))
      throw fail("执行计划步骤类型不能包含访问器或空洞");
    const step = entry.value;
    if (
      !step ||
      typeof step !== "object" ||
      Array.isArray(step) ||
      isProxy(step) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(step))
    )
      throw fail("执行计划步骤类型须来自普通数据对象");
    const descriptor = Object.getOwnPropertyDescriptor(step, "type");
    if (
      descriptor &&
      (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
    )
      throw fail("执行计划步骤类型不能包含访问器");
    const type = descriptor?.value;
    if (
      type !== undefined &&
      !["http", "grpc", "socketio", "protocol"].includes(type)
    )
      throw fail("未知执行计划步骤类型");
  }
}

// Compare against parsed disk data without invoking candidate getters, Proxy
// traps or conversion hooks. The traversal is bounded by the finite disk tree.
export function sameStoredPlan(candidate, stored) {
  const pending = [[candidate, stored]];
  while (pending.length) {
    const [value, old] = pending.pop();
    if (value === null || typeof value !== "object") {
      if (!Object.is(value, old)) return false;
      continue;
    }
    if (
      isProxy(value) ||
      old === null ||
      typeof old !== "object" ||
      Object.getPrototypeOf(value) !== Object.getPrototypeOf(old)
    )
      return false;
    const keys = Reflect.ownKeys(value),
      oldKeys = Reflect.ownKeys(old);
    if (keys.length !== oldKeys.length) return false;
    for (const key of oldKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const expected = Object.getOwnPropertyDescriptor(old, key);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== expected.enumerable
      )
        return false;
      pending.push([descriptor.value, expected.value]);
    }
  }
  return true;
}

export function validatePlanDefinitionTypes(plan) {
  if (
    !plan ||
    typeof plan !== "object" ||
    isProxy(plan) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(plan))
  )
    throw fail("执行计划步骤类型须来自普通数据对象");
  const descriptor = Object.getOwnPropertyDescriptor(plan, "steps");
  if (!descriptor || !Object.hasOwn(descriptor, "value"))
    throw fail("执行计划步骤类型不能包含访问器");
  validatePlanStepTypes(descriptor.value);
}
