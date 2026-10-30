// Canonical definition traversal only. No transport, interpolation, or execution.
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function object(value, label, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("循环计划" + label + "须为普通对象");
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      (keys && !keys.includes(key))
    )
      throw Error("循环计划" + label + "含未知字段或访问器");
  }
}
function array(value, label) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    !value.length ||
    value.length > 200
  )
    throw Error("循环计划" + label + "须包含1至200项");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) throw Error("循环计划数组格式无效");
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !Object.hasOwn(d, "value"))
      throw Error("循环计划数组不能含空洞或访问器");
  }
}
export function hasRepeatSteps(steps) {
  if (!Array.isArray(steps)) return false;
  for (let i = 0; i < steps.length; i++) {
    const item = Object.getOwnPropertyDescriptor(steps, String(i));
    if (!item || !Object.hasOwn(item, "value")) continue;
    const type =
      item.value && Object.getOwnPropertyDescriptor(item.value, "type");
    if (type?.value === "repeat") return true;
  }
  return false;
}
function dataOnly(root) {
  const seen = new Set();
  let nodes = 0;
  const visit = (value, depth) => {
    if (++nodes > 100000 || depth > 32) throw Error("循环计划数据结构超限");
    if (
      value === undefined ||
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return;
    if (typeof value !== "object" || seen.has(value))
      throw Error("循环计划须为无循环的普通数据");
    seen.add(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype)
        throw Error("循环计划数组原型无效");
    } else object(value, "数据");
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        !d.enumerable ||
        !Object.hasOwn(d, "value")
      )
        throw Error("循环计划数据不能包含访问器");
      visit(d.value, depth + 1);
    }
    seen.delete(value);
  };
  visit(root, 0);
}
export function validateRepeatGraph(steps, { requireIds = false } = {}) {
  if (!hasRepeatSteps(steps)) return false;
  dataOnly(steps);
  array(steps, "步骤");
  const ids = new Set();
  let expanded = 0,
    bytes = 0;
  const identity = (step) => {
    if (step.id === undefined && !requireIds) return;
    if (
      typeof step.id !== "string" ||
      !step.id ||
      step.id.length > 200 ||
      !step.id.isWellFormed() ||
      forbidden.has(step.id) ||
      ids.has(step.id)
    )
      throw Error("循环计划节点ID无效或重复");
    ids.add(step.id);
  };
  const metadata = (step) => {
    identity(step);
    if (step.enabled !== undefined && typeof step.enabled !== "boolean")
      throw Error("循环计划enabled须为布尔值");
    if (
      step.name !== undefined &&
      (typeof step.name !== "string" ||
        step.name.length > 200 ||
        !step.name.isWellFormed())
    )
      throw Error("循环计划名称无效");
  };
  const leaf = (step, nested) => {
    object(
      step,
      "叶子步骤",
      nested
        ? ["protocol", "grpc"].includes(step.type)
          ? [
              "id",
              "name",
              "enabled",
              "type",
              step.type === "grpc" ? "grpc" : "protocol",
              "extract",
              "assertions",
              "expectedStatus",
            ]
          : ["id", "name", "enabled", "type", "request", "expectedStatus"]
        : undefined,
    );
    metadata(step);
    if (nested && step.type === "grpc") {
      object(step.grpc, "gRPC定义");
      const reference = step.grpc.definitionId;
      if (reference !== undefined) {
        if (
          requireIds ||
          typeof reference !== "string" ||
          !reference.trim() ||
          step.grpc.definition !== undefined
        )
          throw Error("循环gRPC引用须在冻结前解析且不能混合定义");
      } else object(step.grpc.definition, "gRPC定义");
      return;
    }
    if (nested && step.type === "protocol") {
      object(step.protocol, "协议定义");
      const reference = step.protocol.definitionId;
      if (reference !== undefined) {
        if (
          requireIds ||
          typeof reference !== "string" ||
          !reference.trim() ||
          step.protocol.definition !== undefined
        )
          throw Error("循环协议引用须在冻结前解析且不能混合定义");
      } else {
        object(step.protocol.definition, "协议定义");
        if (
          !["tcp", "websocket", "sse"].includes(step.protocol.definition.type)
        )
          throw Error("循环组协议叶子仅支持TCP、WebSocket或SSE");
      }
      return;
    }
    if (step.type !== undefined && step.type !== "http") {
      if (!nested && ["grpc", "socketio", "protocol"].includes(step.type))
        return;
      throw Error(
        "循环组仅支持HTTP、gRPC或TCP/WebSocket/SSE叶子，不支持嵌套或其他步骤类型",
      );
    }
    object(step.request, "请求");
    if (typeof step.request.url !== "string" || !step.request.url.trim())
      throw Error("循环计划HTTP请求URL不能为空");
    if (
      step.expectedStatus !== undefined &&
      (!Number.isInteger(step.expectedStatus) ||
        step.expectedStatus < 100 ||
        step.expectedStatus > 599)
    )
      throw Error("循环计划HTTP预期状态无效");
  };
  for (const step of steps) {
    object(step, "步骤");
    if (step.type === "repeat") {
      object(step, "循环组", [
        "type",
        "id",
        "name",
        "enabled",
        "count",
        "steps",
      ]);
      metadata(step);
      if (!Number.isInteger(step.count) || step.count < 1 || step.count > 100)
        throw Error("循环次数须为1至100的整数");
      array(step.steps, "循环子步骤");
      for (const child of step.steps) leaf(child, true);
      expanded += step.count * step.steps.length;
      for (const child of step.steps)
        bytes += Buffer.byteLength(JSON.stringify(child)) * step.count;
    } else {
      leaf(step, false);
      expanded++;
      bytes += Buffer.byteLength(JSON.stringify(step));
    }
    // Disabled definitions are deliberately included, so toggling enabled cannot
    // bypass the same potential-work budget.
    if (expanded > 200) throw Error("循环计划展开最多200个请求步骤");
    if (bytes > 4 * 1024 * 1024) throw Error("循环计划逻辑展开配置最多4MiB");
  }
  return true;
}
export function planLeaves(steps) {
  return steps.flatMap((step) =>
    step.type === "repeat" ? step.steps : [step],
  );
}
// Active definitions, once each: grants are not duplicated per iteration.
export function activePlanLeaves(steps) {
  validateRepeatGraph(steps, { requireIds: true });
  return steps
    .filter((step) => step.enabled !== false)
    .flatMap((step) =>
      step.type === "repeat"
        ? step.steps.filter((child) => child.enabled !== false)
        : [step],
    );
}
export const REPEAT_EVIDENCE_BYTES = 8 * 1024 * 1024;
export function repeatEvidenceExceeded(bytes) {
  return bytes > REPEAT_EVIDENCE_BYTES;
}
export function mapPlanLeaves(steps, map) {
  return steps.map((step) =>
    step.type === "repeat"
      ? { ...step, steps: step.steps.map(map) }
      : map(step),
  );
}
export function planOccurrences(steps) {
  const occurrences = [];
  for (const step of steps) {
    if (step.enabled === false) continue;
    if (step.type !== "repeat") {
      occurrences.push({ step });
      continue;
    }
    for (let iteration = 0; iteration < step.count; iteration++)
      for (const child of step.steps) {
        if (child.enabled === false) continue;
        occurrences.push({
          step: child,
          repeat: {
            groupId: step.id,
            childId: child.id,
            iteration,
            // JSON tuple is injective even when IDs contain separators.
            occurrenceId: JSON.stringify([step.id, child.id, iteration]),
          },
        });
      }
  }
  return occurrences;
}
export function activePlanStepCount(plan) {
  validateRepeatGraph(plan.steps, { requireIds: true });
  return planOccurrences(plan.steps).length;
}
