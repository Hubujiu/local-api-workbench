import { isProxy } from "node:util/types";

// Read a closed own-data policy before spreads, cloning or execution. Omission
// and explicit continue intentionally have the same legacy serialized form.
export function readPlanFailurePolicy(plan) {
  if (!plan || typeof plan !== "object" || isProxy(plan))
    throw Error("计划失败策略failurePolicy须来自普通数据对象");
  const descriptor = Object.getOwnPropertyDescriptor(plan, "failurePolicy");
  if (!descriptor) return undefined;
  if (
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, "value") ||
    !["continue", "stop"].includes(descriptor.value)
  )
    throw Error("计划失败策略failurePolicy仅支持continue或stop");
  return descriptor.value === "stop" ? "stop" : undefined;
}

function data(object, key) {
  if (!object || typeof object !== "object" || isProxy(object))
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor?.enumerable && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}
const identity = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  value.isWellFormed();
function repeatIdentity(raw, stepId) {
  const groupId = data(raw, "groupId"),
    childId = data(raw, "childId"),
    iteration = data(raw, "iteration"),
    occurrenceId = data(raw, "occurrenceId");
  if (
    !identity(groupId) ||
    childId !== stepId ||
    !Number.isInteger(iteration) ||
    iteration < 0 ||
    iteration >= 100
  )
    return undefined;
  const rawPath = data(raw, "path");
  let path;
  if (rawPath !== undefined) {
    if (
      isProxy(rawPath) ||
      !Array.isArray(rawPath) ||
      rawPath.length < 1 ||
      rawPath.length > 4
    )
      return undefined;
    path = [];
    for (let i = 0; i < rawPath.length; i++) {
      const entry = data(rawPath, String(i)),
        id = data(entry, "groupId"),
        index = data(entry, "iteration");
      if (
        !identity(id) ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= 100
      )
        return undefined;
      path.push({ groupId: id, iteration: index });
    }
    if (path.at(-1).groupId !== groupId || path.at(-1).iteration !== iteration)
      return undefined;
  }
  const expected = JSON.stringify(
    path
      ? [path.map((item) => [item.groupId, item.iteration]), childId]
      : [groupId, childId, iteration],
  );
  if (occurrenceId !== expected) return undefined;
  return {
    groupId,
    childId,
    iteration,
    occurrenceId,
    ...(path ? { path } : {}),
  };
}

// History is imported/user-editable data: never copy arbitrary extra fields or
// serialize the raw stop payload. Identity projection has fixed structural caps.
export function failureStopSummary(record) {
  const reason = data(record, "stopReason");
  if (reason === "scope-commit-unknown") return { stopReason: reason };
  if (reason !== "step-failure") return {};
  const raw = data(record, "failureStop"),
    stepId = data(raw, "stepId");
  if (!identity(stepId)) return { stopReason: reason };
  const sourceRepeat = data(raw, "repeat"),
    repeat = repeatIdentity(sourceRepeat, stepId);
  return {
    stopReason: reason,
    failureStop: {
      stepId,
      ...(repeat
        ? { repeat }
        : sourceRepeat === undefined
          ? {}
          : { repeatOmitted: true }),
    },
  };
}
