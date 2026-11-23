import { isProxy } from "node:util/types";
import {
  assertHTTPPreWaitEligible,
  httpPreWaitUnsupported,
  maxHTTPPreWaitMilliseconds,
} from "../public/http-pre-wait-contract.js";
import { jsonPathSegments } from "./json-path.mjs";
import {
  validateDatabaseOperationBinding,
  validateDatabaseOperationHeader,
} from "./plan-database-operation.mjs";

// Only host code can opt a single, ordinary manual Debug execution into Wait.
export const manualHTTPPreWait = Symbol("manualHTTPPreWait");

const fields = ["type", "waitVersion", "milliseconds", "enabled"];

const invalidData = () =>
  Error("前置等待检查只接受普通数据，不接受访问器或代理");

function ownData(value, key) {
  if (isProxy(value)) throw invalidData();
  if (!value || typeof value !== "object") return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (![Object.prototype, Array.prototype, null].includes(prototype))
    throw invalidData();
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (property && !Object.hasOwn(property, "value")) throw invalidData();
  return property;
}

function* rowsForWait(request, phase) {
  const rows = ownData(request, phase)?.value;
  if (isProxy(rows)) throw invalidData();
  if (!Array.isArray(rows)) return;
  for (let index = 0; index < rows.length; index++) {
    const operation = ownData(rows, String(index))?.value;
    const type = ownData(operation, "type")?.value;
    const versioned = Boolean(ownData(operation, "waitVersion"));
    yield { operation, type, versioned, marker: type === "wait" || versioned };
  }
}

function contains(request, phase, field = "marker") {
  for (const row of rowsForWait(request, phase)) if (row[field]) return true;
  return false;
}

export function rejectHTTPPreWait(request, destination) {
  for (const phase of ["before", "after"])
    if (contains(request, phase)) throw httpPreWaitUnsupported(destination);
}

// When Wait extends the ordinary pipeline, admit the whole before list before
// the first delay, variable operation, database query, or script can begin.
export function validateHTTPPreWait(request) {
  if (contains(request, "after"))
    throw Error("等待操作只支持普通 HTTP 调试的前置操作");
  if (!contains(request, "before")) return false;
  assertHTTPPreWaitEligible(request);
  let total = 0;
  let databases = 0;
  for (const { operation, type, marker } of rowsForWait(request, "before")) {
    if (marker) {
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
    } else if (type === "database") {
      if (!validateDatabaseOperationHeader(operation)) continue;
      if (++databases > 5) throw Error("每阶段数据库操作最多5项、累计10秒");
      validateDatabaseOperationBinding(operation);
      jsonPathSegments(operation.path || "$");
    } else if (
      !["set", "uuid", "timestamp", "delete"].includes(type) ||
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
    ["before", "after"].some((phase) => contains(request, phase, "versioned"))
  )
    validateHTTPPreWait(request);
}

export function hasEnabledHTTPPreWait(request) {
  return request.before?.some(
    (operation) => operation.type === "wait" && operation.enabled,
  );
}

export function readPlanStepsForHTTPPreWait(plan) {
  return ownData(plan, "steps")?.value;
}

// Step/type/children already passed validatePlanStepTypes. Do not use the
// ordinary planLeaves traversal here: its leaf callback would read request
// descriptors early, before OAuth and repeat validators can reject hooks.
export function assertHTTPPreWaitAdmission(steps, admission) {
  const visit = (items, nested = false) => {
    for (let index = 0; index < items.length; index++) {
      const step = ownData(items, String(index)).value;
      const type = ownData(step, "type")?.value;
      if (type === "repeat" || type === "if") {
        visit(ownData(step, "steps").value, true);
        continue;
      }
      const request = ownData(step, "request")?.value;
      if (
        !nested &&
        items.length === 1 &&
        (type === undefined || type === "http") &&
        admission === manualHTTPPreWait
      )
        validateHTTPPreWait(request);
      else rejectHTTPPreWait(request, "执行计划");
    }
  };
  visit(steps);
}
