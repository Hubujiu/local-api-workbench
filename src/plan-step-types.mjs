import { isProxy } from "node:util/types";

const fail = (message) =>
  Object.assign(Error(message), { code: "PLAN_STEP_TYPE_INVALID" });

// Missing/undefined is the historical HTTP spelling. Never infer HTTP from an
// unrecognized discriminator. Only inspect graph structure/type here: request
// and auth payloads retain their existing domain-specific preflight ordering.
export function validatePlanStepTypes(steps) {
  const ancestors = new Set();
  // Determine the diagnostic context without evaluating step/type accessors or
  // Proxy traps, even when a malformed sibling precedes a repeat group.
  const hasRepeat =
    Array.isArray(steps) &&
    !isProxy(steps) &&
    steps.length <= 200 &&
    Array.from({ length: steps.length }, (_, index) => {
      const entry = Object.getOwnPropertyDescriptor(steps, String(index));
      const step = entry?.value;
      return (
        step !== null &&
        typeof step === "object" &&
        !isProxy(step) &&
        Object.getOwnPropertyDescriptor(step, "type")?.value === "repeat"
      );
    }).some(Boolean);
  const label = hasRepeat ? "循环计划步骤类型" : "执行计划步骤类型";
  let nodes = 0,
    repeated = false;
  const visit = (items, depth) => {
    if (
      !Array.isArray(items) ||
      isProxy(items) ||
      items.length > 200 ||
      depth > 4 ||
      ancestors.has(items)
    )
      throw fail(label + "或集合无效");
    ancestors.add(items);
    for (let index = 0; index < items.length; index++) {
      if (++nodes > 100000) throw fail(label + "遍历超限");
      const entry = Object.getOwnPropertyDescriptor(items, String(index));
      if (!entry || !Object.hasOwn(entry, "value"))
        throw fail(label + "不能包含访问器或空洞");
      const step = entry.value;
      if (
        !step ||
        typeof step !== "object" ||
        Array.isArray(step) ||
        isProxy(step) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(step))
      )
        throw fail(label + "须来自普通数据对象");
      const descriptor = Object.getOwnPropertyDescriptor(step, "type");
      if (
        descriptor &&
        (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      )
        throw fail(label + "不能包含访问器");
      const type = descriptor?.value;
      if (type === "repeat") {
        repeated = true;
        const children = Object.getOwnPropertyDescriptor(step, "steps");
        if (!children) throw fail("循环计划步骤类型缺少子步骤");
        if (!children.enumerable || !Object.hasOwn(children, "value"))
          throw fail("循环计划步骤类型不能包含子步骤访问器");
        visit(children.value, depth + 1);
      } else if (
        type !== undefined &&
        !["http", "grpc", "socketio", "protocol"].includes(type)
      )
        throw fail("未知" + label);
    }
    ancestors.delete(items);
  };
  visit(steps, 0);
  if (repeated) rejectRepeatDataHooks(steps);
}

// Accessors are never evaluated here. Their owning OAuth/repeat validator keeps
// its existing error. Data-valued descendants are inspected before those
// validators can encounter a Proxy; cycles/depth/work retain the repeat limits.
function rejectRepeatDataHooks(root) {
  const pending = [[root, 0, false]],
    ancestors = new Set();
  let nodes = 0;
  while (pending.length) {
    const [value, depth, exit] = pending.pop();
    if (exit) {
      ancestors.delete(value);
      continue;
    }
    if (++nodes > 100000 || depth > 32) throw fail("循环计划数据结构超限");
    if (isProxy(value)) throw fail("循环计划数据不能包含Proxy");
    if (value === null || typeof value !== "object") continue;
    const prototype = Object.getPrototypeOf(value);
    if (
      !(
        Array.isArray(value) ? [Array.prototype] : [Object.prototype, null]
      ).includes(prototype)
    )
      throw fail("循环计划数据原型无效");
    if (ancestors.has(value)) throw fail("循环计划须为无循环的普通数据");
    ancestors.add(value);
    pending.push([value, depth, true]);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (Object.hasOwn(descriptor, "value"))
        pending.push([descriptor.value, depth + 1, false]);
    }
  }
}

// Compare against parsed disk data without invoking candidate getters, Proxy
// traps or conversion hooks. The traversal is bounded by the finite disk tree.
export function sameStoredPlan(candidate, stored, maxNodes = Infinity) {
  let nodes = 0;
  const pending = [[candidate, stored]],
    seen = new Set();
  while (pending.length) {
    const [value, old, exit] = pending.pop();
    if (exit) {
      seen.delete(old);
      continue;
    }
    if (++nodes > maxNodes) return false;
    if (["function", "symbol"].includes(typeof value)) return false;
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
    if (
      seen.has(old) ||
      ![Object.prototype, Array.prototype, null].includes(
        Object.getPrototypeOf(value),
      )
    )
      return false;
    seen.add(old);
    pending.push([value, old, true]);
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
      if (Array.isArray(old) && key === "length") {
        if (descriptor.value !== expected.value) return false;
      } else pending.push([descriptor.value, expected.value]);
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
