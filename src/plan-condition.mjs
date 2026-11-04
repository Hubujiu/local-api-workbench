import { types } from "node:util";
import { variableName } from "./variable-scopes.mjs";

const ops = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "notContains",
]);
const numericOps = new Set(["gt", "gte", "lt", "lte"]);
const textOps = new Set(["contains", "notContains"]);
const scopes = new Set(["globals", "environment", "runtime", "iterationData"]);
const fail = (message) =>
  Object.assign(Error("条件计划" + message), {
    code: "PLAN_CONDITION_INVALID",
  });
function object(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw fail("须为普通数据对象");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors))
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    )
      throw fail("包含未知字段或访问器");
  return descriptors;
}
function primitive(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.isWellFormed() &&
    value.length <= 8192 &&
    Buffer.byteLength(value) <= 8192
  )
    return value;
  throw fail("比较值仅支持null、布尔、有限数字或1至8192 UTF-8字节文本");
}
function operand(value) {
  const fields = object(value, ["literal", "scope", "name"]);
  if (Object.hasOwn(fields, "literal")) {
    if (Object.keys(fields).length !== 1) throw fail("字面值不能混合变量来源");
    primitive(fields.literal.value);
  } else {
    if (Object.keys(fields).length !== 2 || !scopes.has(fields.scope?.value))
      throw fail("变量须显式选择globals/environment/runtime/iterationData");
    variableName(fields.name?.value);
    if (!fields.name.value.isWellFormed()) throw fail("变量名称无效");
  }
}
function validateKnownType(op, value) {
  if (numericOps.has(op) && typeof value !== "number")
    throw fail("顺序比较仅支持有限数字");
  if (textOps.has(op) && typeof value !== "string")
    throw fail("文本包含比较仅支持文本");
}
export function validatePlanCondition(condition) {
  const fields = object(condition, ["op", "left", "right"]);
  if (Object.keys(fields).length !== 3 || !ops.has(fields.op?.value))
    throw fail("比较操作无效");
  operand(fields.left?.value);
  operand(fields.right?.value);
  if (
    Object.hasOwn(condition.left, "literal") &&
    Object.hasOwn(condition.right, "literal")
  )
    compare(condition.left.literal, condition.op, condition.right.literal);
  else
    for (const side of [condition.left, condition.right])
      if (Object.hasOwn(side, "literal"))
        validateKnownType(condition.op, side.literal);
  return condition;
}
function compare(left, op, right) {
  primitive(left);
  primitive(right);
  if (typeof left !== typeof right || (left === null) !== (right === null))
    throw fail("比较值类型不匹配，禁止隐式转换");
  if (op === "eq") return left === right;
  if (op === "neq") return left !== right;
  if (textOps.has(op)) {
    validateKnownType(op, left);
    const contains = left.includes(right);
    return op === "contains" ? contains : !contains;
  }
  if (typeof left !== "number") throw fail("顺序比较仅支持有限数字");
  if (op === "gt") return left > right;
  if (op === "gte") return left >= right;
  if (op === "lt") return left < right;
  if (op === "lte") return left <= right;
  throw fail("比较操作无效");
}
// Validate all potential row values before executing any branch. Rows are
// already strict frozen JSON; do not treat row fields as mutable variables.
export function validateIterationDataCondition(condition, rows) {
  const sides = [condition.left, condition.right];
  const needed = sides.filter((side) => side.scope === "iterationData");
  if (!needed.length) return;
  if (!rows) throw fail("iterationData 只能用于数据行循环内部");
  for (const row of rows) {
    for (const side of needed) {
      const descriptor = Object.getOwnPropertyDescriptor(row, side.name);
      if (!descriptor || !Object.hasOwn(descriptor, "value"))
        throw fail("数据行字段不存在");
      primitive(descriptor.value);
    }
    const values = sides.map((side) =>
      Object.hasOwn(side, "literal")
        ? side.literal
        : side.scope === "iterationData"
          ? row[side.name]
          : undefined,
    );
    if (values.every((value) => value !== undefined))
      compare(values[0], condition.op, values[1]);
    else
      for (const value of values)
        if (value !== undefined) validateKnownType(condition.op, value);
  }
}
export function evaluatePlanCondition(condition, state, iterationData) {
  validatePlanCondition(condition);
  const resolve = (value) => {
    if (Object.hasOwn(value, "literal")) return value.literal;
    if (value.scope === "iterationData") {
      if (
        !iterationData ||
        typeof iterationData !== "object" ||
        Array.isArray(iterationData) ||
        types.isProxy(iterationData) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(iterationData))
      )
        throw fail("数据行不可用");
      const descriptor = Object.getOwnPropertyDescriptor(
        iterationData,
        value.name,
      );
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      )
        throw fail("数据行字段不存在");
      return descriptor.value;
    }
    // Deliberately do not resurrect a value hidden by legacy runtime deletion.
    if (state.hidden.includes(value.name)) throw fail("引用的变量已隐藏");
    const map = state[value.scope];
    if (!map || types.isProxy(map)) throw fail("变量层无效");
    const descriptor = Object.getOwnPropertyDescriptor(map, value.name);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.value === undefined
    )
      throw fail("引用的变量不存在");
    return descriptor.value;
  };
  return compare(
    resolve(condition.left),
    condition.op,
    resolve(condition.right),
  );
}

// Run before createScopes, which otherwise copies values through JSON.stringify.
// This is only enabled for IF plans; other existing input contracts are unchanged.
export function validateConditionScopeInput(variables, input) {
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set();
  const visit = (value, depth = 0) => {
    if (++nodes > 100000 || depth > 32) throw fail("变量输入超过节点/深度预算");
    if (value === undefined || value === null || typeof value === "boolean") {
      bytes += 8;
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw fail("变量输入必须包含有限数字");
      bytes += 32;
      return;
    }
    if (typeof value === "string") {
      if (!value.isWellFormed() || value.length > 4 * 1024 * 1024)
        throw fail("变量文本无效或超限");
      bytes += Buffer.byteLength(value) * 6 + 2;
      if (bytes > 4 * 1024 * 1024) throw fail("变量输入超过4MiB预算");
      return;
    }
    if (
      typeof value !== "object" ||
      types.isProxy(value) ||
      ancestors.has(value)
    )
      throw fail("变量输入须为无钩子JSON数据");
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (
      array
        ? proto !== Array.prototype
        : ![Object.prototype, null].includes(proto)
    )
      throw fail("变量输入原型无效");
    for (const target of [value, proto, Object.prototype]) {
      const hook = target && Object.getOwnPropertyDescriptor(target, "toJSON");
      if (
        hook &&
        (!Object.hasOwn(hook, "value") || typeof hook.value === "function")
      )
        throw fail("变量输入不能自定义序列化");
    }
    const fields = Object.getOwnPropertyDescriptors(value),
      keys = Reflect.ownKeys(fields);
    if (
      keys.length > 100001 ||
      (array && (value.length > 100000 || keys.length !== value.length + 1))
    )
      throw fail("变量输入数组或工作量无效");
    ancestors.add(value);
    bytes += 2;
    if (array)
      for (let i = 0; i < value.length; i++)
        if (!Object.hasOwn(fields, String(i)))
          throw fail("变量输入数组不能有空洞");
    for (const key of keys) {
      if (array && key === "length") continue;
      const field = fields[key];
      if (
        typeof key !== "string" ||
        !field.enumerable ||
        !Object.hasOwn(field, "value")
      )
        throw fail("变量输入不能包含访问器");
      visit(key, depth + 1);
      visit(field.value, depth + 1);
    }
    ancestors.delete(value);
    if (bytes > 4 * 1024 * 1024) throw fail("变量输入超过4MiB预算");
  };
  visit(variables);
  visit(input);
  if (
    variables !== undefined &&
    (!variables || typeof variables !== "object" || Array.isArray(variables))
  )
    throw fail("初始变量层无效");
  if (input !== undefined) {
    object(input, ["globals", "environment", "runtime", "hidden"]);
    for (const key of ["globals", "environment", "runtime"]) {
      if (input[key] === undefined) continue;
      const map = input[key];
      if (!map || typeof map !== "object" || Array.isArray(map))
        throw fail("显式变量层须为普通映射");
      for (const name of Object.keys(map)) variableName(name);
    }
    if (input.hidden !== undefined) {
      if (!Array.isArray(input.hidden)) throw fail("隐藏变量名须为数组");
      for (const name of input.hidden) variableName(name);
    }
  }
}
