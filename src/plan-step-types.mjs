import { isProxy } from "node:util/types";

// Missing/undefined is the historical HTTP spelling. Never infer HTTP from an
// unrecognized discriminator. This baseline has no repeat-group capability.
export function validatePlanStepTypes(steps) {
  if (!Array.isArray(steps) || isProxy(steps) || steps.length > 200)
    throw Error("执行计划步骤类型或集合无效");
  for (let index = 0; index < steps.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(steps, String(index));
    if (!entry || !Object.hasOwn(entry, "value"))
      throw Error("执行计划步骤类型不能包含访问器或空洞");
    const step = entry.value;
    if (
      !step ||
      typeof step !== "object" ||
      Array.isArray(step) ||
      isProxy(step) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(step))
    )
      throw Error("执行计划步骤类型须来自普通数据对象");
    const descriptor = Object.getOwnPropertyDescriptor(step, "type");
    if (
      descriptor &&
      (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
    )
      throw Error("执行计划步骤类型不能包含访问器");
    const type = descriptor?.value;
    if (
      type !== undefined &&
      !["http", "grpc", "socketio", "protocol"].includes(type)
    )
      throw Error("未知执行计划步骤类型");
  }
}
