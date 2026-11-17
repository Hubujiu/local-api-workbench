import { isProxy } from "node:util/types";

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const valid = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  value.isWellFormed() &&
  !forbidden.has(value);
const fail = () => {
  throw Error("执行计划步骤ID无效或重复");
};

// Only ordinary linear definition identities; repeat graphs retain their own
// existing validation. Never inspect requests, execute callbacks, or edit input.
export function linearPlanStepIds(steps, { allowMissing = true } = {}) {
  if (!Array.isArray(steps) || isProxy(steps) || steps.length > 200) fail();
  const ids = [],
    seen = new Set();
  for (let index = 0; index < steps.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(steps, String(index));
    if (!entry || !Object.hasOwn(entry, "value")) fail();
    const step = entry.value;
    if (
      !step ||
      typeof step !== "object" ||
      Array.isArray(step) ||
      isProxy(step) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(step))
    )
      fail();
    const descriptor = Object.getOwnPropertyDescriptor(step, "id");
    if (
      descriptor &&
      (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
    )
      fail();
    const value = descriptor?.value;
    if (allowMissing && (value === undefined || value === "")) {
      ids.push(undefined);
      continue;
    }
    if (!valid(value) || seen.has(value)) fail();
    seen.add(value);
    ids.push(value);
  }
  return ids;
}

export function allocateLinearPlanStepIds(steps, generateId) {
  // Validate the whole batch before allocating even the first missing identity.
  const ids = linearPlanStepIds(steps),
    seen = new Set(ids.filter((id) => id !== undefined));
  return ids.map((id) => {
    if (id !== undefined) return id;
    const generated = generateId();
    if (!valid(generated) || seen.has(generated)) fail();
    seen.add(generated);
    return generated;
  });
}

export function ownStepProvenance(steps, id) {
  return steps && Object.hasOwn(steps, id) ? steps[id] : undefined;
}
