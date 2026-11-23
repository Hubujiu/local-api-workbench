import {
  assertHTTPPreWaitEligible,
  containsHTTPPreWaitMarker,
  hasHTTPPreWaitVersion,
  isHTTPPreWaitMarker,
  maxHTTPPreWaitMilliseconds,
  rejectHTTPPreWait,
} from "../public/http-pre-wait-contract.js";
export { rejectHTTPPreWait };
import { jsonPathSegments } from "./json-path.mjs";
import {
  validateDatabaseOperationBinding,
  validateDatabaseOperationHeader,
} from "./plan-database-operation.mjs";

// Only host code can opt a single, ordinary manual Debug execution into Wait.
export const manualHTTPPreWait = Symbol("manualHTTPPreWait");

const fields = ["type", "waitVersion", "milliseconds", "enabled"];

// When Wait extends the ordinary pipeline, admit the whole before list before
// the first delay, variable operation, database query, or script can begin.
export function validateHTTPPreWait(request) {
  if (containsHTTPPreWaitMarker(request?.after))
    throw Error("等待操作只支持普通 HTTP 调试的前置操作");
  if (!containsHTTPPreWaitMarker(request?.before)) return false;
  assertHTTPPreWaitEligible(request);
  let total = 0;
  let databases = 0;
  for (const operation of request.before) {
    if (isHTTPPreWaitMarker(operation)) {
      if (
        !operation ||
        Array.isArray(operation) ||
        Reflect.ownKeys(operation).length !== fields.length ||
        fields.some((key) => {
          const field = Object.getOwnPropertyDescriptor(operation, key);
          return !field?.enumerable || !Object.hasOwn(field, "value");
        }) ||
        operation.type !== "wait" ||
        operation.waitVersion !== 1 ||
        typeof operation.enabled !== "boolean" ||
        !Number.isInteger(operation.milliseconds) ||
        operation.milliseconds < 0 ||
        operation.milliseconds > maxHTTPPreWaitMilliseconds
      )
        throw Error("前置等待配置无效：须使用 v1、布尔开关和 0–10000 毫秒整数");
      if (operation.enabled) total += operation.milliseconds;
      if (total > maxHTTPPreWaitMilliseconds)
        throw Error("每个请求已启用的前置等待合计最多 10000 毫秒");
    } else if (operation?.type === "database") {
      if (!validateDatabaseOperationHeader(operation)) continue;
      if (++databases > 5) throw Error("每阶段数据库操作最多5项、累计10秒");
      validateDatabaseOperationBinding(operation);
      jsonPathSegments(operation.path || "$");
    } else if (
      !["set", "uuid", "timestamp", "delete"].includes(operation?.type) ||
      typeof operation.name !== "string" ||
      !operation.name ||
      ["__proto__", "constructor", "prototype"].includes(operation.name)
    ) {
      throw Error("前置等待所在阶段包含无效的普通前置操作");
    }
  }
  return true;
}

// Older ordinary unmarked rows were never executable. Inert definitions can be
// read, backed up or normalized during an unrelated save without upgrading them.
export function validateHTTPPreWaitDefinition(request) {
  if (
    [request.before, request.after].some(
      (rows) => Array.isArray(rows) && rows.some(hasHTTPPreWaitVersion),
    )
  )
    validateHTTPPreWait(request);
}

export function hasEnabledHTTPPreWait(request) {
  return request.before?.some(
    (operation) => operation.type === "wait" && operation.enabled,
  );
}

export function assertHTTPPreWaitAdmission(plan, steps, admission) {
  const supported =
    admission === manualHTTPPreWait &&
    Array.isArray(plan.steps) &&
    plan.steps.length === 1 &&
    (plan.steps[0]?.type === undefined || plan.steps[0]?.type === "http");
  for (const step of steps) {
    if (supported && step === plan.steps[0]) validateHTTPPreWait(step.request);
    else rejectHTTPPreWait(step.request, "执行计划");
  }
}
