import { types } from "node:util";
import { variableName } from "./variable-scopes.mjs";
import {
  validatePlanCondition,
  validateIterationDataCondition,
} from "./plan-condition.mjs";
import { normalizeExecutionContext } from "./script-context.mjs";
// Canonical definition traversal only. No transport, interpolation, or execution.
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function object(value, label, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    types.isProxy(value) ||
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
// Historical API name: all canonical control groups require the same non-linear consumers.
export function hasRepeatSteps(steps) {
  if (!Array.isArray(steps)) return false;
  for (let i = 0; i < steps.length; i++) {
    const item = Object.getOwnPropertyDescriptor(steps, String(i));
    if (!item || !Object.hasOwn(item, "value")) continue;
    const type =
      item.value && Object.getOwnPropertyDescriptor(item.value, "type");
    if (["repeat", "if"].includes(type?.value)) return true;
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
    if (typeof value !== "object" || types.isProxy(value) || seen.has(value))
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
function validateRowsJSON(value) {
  let nodes = 0;
  const walk = (item, depth) => {
    if (types.isProxy(item)) throw Error("数据行不能包含代理");
    if (++nodes > 100000 || depth > 32) throw Error("数据行结构超限");
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (
      typeof item === "number" &&
      Number.isFinite(item) &&
      !Object.is(item, -0)
    )
      return;
    if (!item || typeof item !== "object") throw Error("数据行必须是严格 JSON");
    if (Array.isArray(item)) {
      if (
        Object.getPrototypeOf(item) !== Array.prototype ||
        Reflect.ownKeys(item).length !== item.length + 1
      )
        throw Error("数据行数组必须稠密且没有额外属性");
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
          throw Error("数据行数组必须稠密且没有访问器");
        walk(descriptor.value, depth + 1);
      }
      return;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw Error("数据行对象原型无效");
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        typeof key !== "string" ||
        forbidden.has(key) ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      )
        throw Error("数据行字段不安全");
      walk(descriptor.value, depth + 1);
    }
  };
  walk(value, 0);
}

const RUNTIME_ROWS_CONTEXT = Symbol("runtime rows context");
export const RUNTIME_ROWS_CONTROL_LIMIT = 200;
export const RUNTIME_ROWS_DEFAULT_MAX_ROW_BYTES = 16 * 1024;
export function runtimeRowsMaxRowBytes(step) {
  object(step, "运行时数据行定义");
  return step.maxRowBytes ?? RUNTIME_ROWS_DEFAULT_MAX_ROW_BYTES;
}

// The dynamic source is an exact runtime key, never a template or a fallback scope.
export function validateRuntimeRowsDefinition(step) {
  object(step, "运行时数据行定义");
  object(step.rowsFrom, "运行时数据行来源", ["scope", "name"]);
  if (step.rowsFrom.scope !== "runtime")
    throw Error("运行时数据行来源须显式指定runtime作用域");
  variableName(step.rowsFrom.name);
  if (!step.rowsFrom.name.isWellFormed())
    throw Error("运行时数据行变量名称无效");
  if (
    ["count", "rows", "untilCondition"].some((key) => Object.hasOwn(step, key))
  )
    throw Error("运行时数据行循环不能混合count、rows或untilCondition");
  if (
    Object.hasOwn(step, "maxRowBytes") &&
    (!Number.isInteger(step.maxRowBytes) ||
      step.maxRowBytes < 1 ||
      step.maxRowBytes > 512 * 1024)
  )
    throw Error("运行时数据行maxRowBytes须为1至524288的整数");
  if (!Number.isInteger(step.maxRows) || step.maxRows < 1 || step.maxRows > 100)
    throw Error("运行时数据行maxRows须为1至100的整数");
}

// Resolve the source separately in the executor, then snapshot the entire array
// before any child runs. No truncation, JSON coercion, or lazy row validation.
export function validateRuntimeRows(step, value) {
  validateRepeatGraph([step], { requireIds: true, allowRuntimeRows: true });
  if (
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > step.maxRows
  )
    throw Error("运行时数据行须为不超过maxRows的普通数组");
  validateRowsJSON(value);
  let totalBytes = 2;
  const rows = [];
  for (let iteration = 0; iteration < value.length; iteration++) {
    const row = value[iteration];
    object(row, "运行时数据行");
    const json = JSON.stringify(row);
    const bytes = Buffer.byteLength(json);
    totalBytes += bytes + (iteration ? 1 : 0);
    if (bytes > runtimeRowsMaxRowBytes(step))
      throw Error("运行时数据行超过maxRowBytes");
    if (totalBytes > 4 * 1024 * 1024) throw Error("运行时数据行快照最多4MiB");
    rows.push(
      normalizeExecutionContext({
        iteration,
        iterationCount: value.length,
        iterationData: row,
      }).iterationData,
    );
  }
  // The inline validator checks every condition (including disabled branches),
  // and charges actual row bytes against potential descendant multiplicity.
  if (rows.length) {
    const { rowsFrom, maxRows, maxRowBytes, ...fixed } = step;
    validateRepeatGraph([{ ...fixed, count: rows.length, rows }], {
      requireIds: true,
    });
  }
  const freeze = (item) => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(rows);
}

export function repeatIterationLimit(step) {
  object(step, "循环定义");
  return Object.hasOwn(step, "rowsFrom") ? step.maxRows : step.count;
}

export function hasRuntimeRows(steps, { activeOnly = false } = {}) {
  const ancestors = new Set();
  let nodes = 0;
  // This detector runs before graph validation. Never use direct property reads,
  // array methods, or reflection on proxies while deciding which path to take.
  const field = (value, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !Object.hasOwn(descriptor, "value"))
      throw Error("循环计划不能包含访问器");
    return descriptor?.value;
  };
  const visit = (items, depth) => {
    if (types.isProxy(items) || !Array.isArray(items))
      throw Error("循环计划步骤须为普通数组");
    if (depth > 32 || ancestors.has(items))
      throw Error("循环计划数据结构超限或循环引用");
    ancestors.add(items);
    let found = false;
    const length = field(items, "length");
    for (let i = 0; i < length; i++) {
      if (++nodes > 100000) throw Error("循环计划数据结构超限");
      const step = field(items, String(i));
      if (types.isProxy(step) || !step || typeof step !== "object")
        throw Error("循环计划步骤须为普通对象");
      object(step, "步骤");
      const type = field(step, "type");
      const enabled = field(step, "enabled");
      if (activeOnly && enabled === false) continue;
      if (!["repeat", "if"].includes(type)) continue;
      // Check even a matched group's children, so an early match cannot hide a
      // getter/proxy which the compiler would otherwise subsequently traverse.
      if (type === "repeat" && Object.hasOwn(step, "rowsFrom")) found = true;
      found = visit(field(step, "steps"), depth + 1) || found;
    }
    ancestors.delete(items);
    return found;
  };
  return visit(steps, 0);
}

// Worst-case HTTP/request count, excluding controls and disabled definitions.
// This is a budget/progress ceiling, not the eventual number of runtime rows.
export function potentialPlanStepCount(
  plan,
  { allowRuntimeRows = false } = {},
) {
  object(plan, "计划");
  dataOnly(plan.steps);
  validateRepeatGraph(plan.steps, { requireIds: true, allowRuntimeRows });
  const count = (steps) =>
    steps.reduce(
      (total, step) =>
        total +
        (step.enabled === false
          ? 0
          : step.type === "repeat"
            ? repeatIterationLimit(step) * count(step.steps)
            : step.type === "if"
              ? count(step.steps)
              : 1),
      0,
    );
  return count(plan.steps);
}

export function validateRepeatGraph(
  steps,
  { requireIds = false, allowRuntimeRows = false } = {},
) {
  // Safely inspect only graph fields before the historical shallow detector.
  // Do not apply the control-graph JSON/depth contract to unused linear metadata.
  // This descriptor-only traversal rejects graph proxies/accessors without
  // touching request payloads; genuine control graphs still get full admission.
  if (allowRuntimeRows) hasRuntimeRows(steps);
  if (!hasRepeatSteps(steps)) return false;
  dataOnly(steps);
  array(steps, "步骤");
  const ids = new Set();
  let expanded = 0,
    bytes = 0,
    decisions = 0,
    waitMs = 0,
    runtimeControls = 0;
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
        ? ["protocol", "grpc", "socketio"].includes(step.type)
          ? [
              "id",
              "name",
              "enabled",
              "type",
              step.type,
              "extract",
              "assertions",
              "expectedStatus",
              ...(step.type === "grpc" ? ["grpcScripts"] : []),
              ...(step.type === "protocol" ? ["protocolScripts"] : []),
            ]
          : [
              "id",
              "name",
              "enabled",
              "type",
              "request",
              "expectedStatus",
              "liveRequestId",
            ]
        : undefined,
    );
    metadata(step);
    if (nested && step.type === "socketio") {
      object(step.socketio, "Socket.IO定义");
      const reference = step.socketio.definitionId;
      if (reference !== undefined) {
        if (
          requireIds ||
          typeof reference !== "string" ||
          !reference.trim() ||
          step.socketio.definition !== undefined
        )
          throw Error("循环Socket.IO引用须在冻结前解析且不能混合定义");
      } else object(step.socketio.definition, "Socket.IO定义");
      return;
    }
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
        "循环组仅支持HTTP、gRPC、Socket.IO或TCP/WebSocket/SSE叶子，不支持其他步骤类型",
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
  const visit = (
    step,
    depth,
    multiplier,
    conditional = false,
    dataDepth = 0,
    rowBytes = 0,
    rowContext,
    until = false,
  ) => {
    object(step, "步骤");
    if (step.type === "if") {
      if (depth >= 4) throw Error("条件/循环组嵌套最多4层");
      object(step, "条件组", [
        "type",
        "id",
        "name",
        "enabled",
        "condition",
        "steps",
      ]);
      metadata(step);
      validatePlanCondition(step.condition);
      if (rowContext !== RUNTIME_ROWS_CONTEXT)
        validateIterationDataCondition(step.condition, rowContext);
      array(step.steps, "条件子步骤");
      decisions += multiplier;
      bytes += Buffer.byteLength(JSON.stringify(step.condition)) * multiplier;
      if (decisions > 200) throw Error("条件计划展开最多200次判断");
      for (const child of step.steps)
        visit(
          child,
          depth + 1,
          multiplier,
          true,
          dataDepth,
          rowBytes,
          rowContext,
          until,
        );
    } else if (step.type === "repeat") {
      if (depth >= 4) throw Error("循环组嵌套最多4层");
      object(step, "循环组", [
        "type",
        "id",
        "name",
        "enabled",
        "count",
        "intervalMs",
        "untilCondition",
        "rows",
        "rowsFrom",
        "maxRows",
        "maxRowBytes",
        "steps",
      ]);
      metadata(step);
      const runtimeRows = Object.hasOwn(step, "rowsFrom");
      if (runtimeRows) {
        if (!allowRuntimeRows) throw Error("当前入口尚未启用运行时数据行循环");
        validateRuntimeRowsDefinition(step);
        if (dataDepth) throw Error("数据行循环暂不支持嵌套数据行循环");
        runtimeControls = Math.min(
          RUNTIME_ROWS_CONTROL_LIMIT + 1,
          runtimeControls + multiplier * (step.maxRows + 2),
        );
        if (runtimeControls > RUNTIME_ROWS_CONTROL_LIMIT)
          throw Error("运行时数据行控制预算最多200项");
      } else {
        if (
          Object.hasOwn(step, "maxRows") ||
          Object.hasOwn(step, "maxRowBytes")
        )
          throw Error("maxRows仅用于运行时数据行循环");
        if (!Number.isInteger(step.count) || step.count < 1 || step.count > 100)
          throw Error("循环次数须为1至100的整数");
      }
      const iterationLimit = repeatIterationLimit(step);
      if (
        step.intervalMs !== undefined &&
        (!Number.isInteger(step.intervalMs) ||
          Object.is(step.intervalMs, -0) ||
          step.intervalMs < 0 ||
          step.intervalMs > 10000)
      )
        throw Error("循环间隔须为0至10000毫秒的整数");
      waitMs += multiplier * (iterationLimit - 1) * (step.intervalMs || 0);
      if (waitMs > 60000) throw Error("循环计划最多等待60000毫秒");
      let nestedRowBytes = runtimeRows
        ? runtimeRowsMaxRowBytes(step)
        : rowBytes;
      if (step.rows !== undefined) {
        if (dataDepth) throw Error("数据行循环暂不支持嵌套数据行循环");
        array(step.rows, "数据行");
        if (step.rows.length !== step.count)
          throw Error("数据行数量必须等于循环次数");
        nestedRowBytes = 0;
        for (let i = 0; i < step.rows.length; i++) {
          object(step.rows[i], "数据行");
          validateRowsJSON(step.rows[i]);
          nestedRowBytes = Math.max(
            nestedRowBytes,
            Buffer.byteLength(JSON.stringify(step.rows[i])),
          );
          normalizeExecutionContext({
            iteration: i,
            iterationCount: step.count,
            iterationData: step.rows[i],
          });
        }
      }
      if (Object.hasOwn(step, "untilCondition")) {
        if (step.rows !== undefined)
          throw Error("条件提前结束循环暂不支持同组数据行");
        validatePlanCondition(step.untilCondition);
        if (rowContext !== RUNTIME_ROWS_CONTEXT)
          validateIterationDataCondition(
            step.untilCondition,
            step.rows === undefined ? rowContext : step.rows,
          );
        decisions += multiplier * step.count;
        bytes +=
          Buffer.byteLength(JSON.stringify(step.untilCondition)) *
          multiplier *
          step.count;
        if (decisions > 200) throw Error("条件计划展开最多200次判断");
      }
      array(step.steps, "循环子步骤");
      for (const child of step.steps)
        visit(
          child,
          depth + 1,
          multiplier * iterationLimit,
          conditional,
          dataDepth + (step.rows === undefined && !runtimeRows ? 0 : 1),
          nestedRowBytes,
          runtimeRows
            ? RUNTIME_ROWS_CONTEXT
            : step.rows === undefined
              ? rowContext
              : step.rows,
          until || Object.hasOwn(step, "untilCondition"),
        );
    } else {
      if (
        rowContext === RUNTIME_ROWS_CONTEXT &&
        step.type !== undefined &&
        step.type !== "http"
      )
        throw Error("运行时数据行循环首版仅支持HTTP叶子");
      // IF and repeat-until have separate transport contracts. Carry the
      // until restriction through nested IF/repeat nodes; a false/disabled branch
      // must not hide an unsupported leaf. References are checked again frozen.
      if (until && step.type !== undefined && step.type !== "http")
        throw Error("条件提前结束循环首版仅支持HTTP叶子");
      if (
        conditional &&
        step.type !== undefined &&
        step.type !== "http" &&
        !(
          step.type === "protocol" &&
          (step.protocol?.definition?.type === "tcp" ||
            (!requireIds && step.protocol?.definitionId !== undefined))
        )
      )
        throw Error("条件组仅支持HTTP或TCP叶子");
      leaf(step, depth > 0);
      expanded += multiplier;
      bytes = Math.min(
        4 * 1024 * 1024 + 1,
        bytes +
          (Buffer.byteLength(JSON.stringify(step)) + rowBytes) * multiplier,
      );
    }
    // Disabled definitions are deliberately included, so toggling enabled cannot
    // bypass the same potential-work budget.
    if (expanded > 200) throw Error("循环计划展开最多200个请求步骤");
    if (bytes > 4 * 1024 * 1024) throw Error("循环计划逻辑展开配置最多4MiB");
  };
  for (const step of steps) visit(step, 0, 1);
  return true;
}
export function planLeaves(steps) {
  return steps.flatMap((step) =>
    ["repeat", "if"].includes(step.type) ? planLeaves(step.steps) : [step],
  );
}
// Active definitions, once each: grants are not duplicated per iteration.
export function activePlanLeaves(steps, { allowRuntimeRows = false } = {}) {
  validateRepeatGraph(steps, { requireIds: true, allowRuntimeRows });
  const visit = (nodes) =>
    nodes.flatMap((step) =>
      step.enabled === false
        ? []
        : ["repeat", "if"].includes(step.type)
          ? visit(step.steps)
          : [step],
    );
  return visit(steps);
}
export const REPEAT_EVIDENCE_BYTES = 8 * 1024 * 1024;
export function repeatEvidenceExceeded(bytes) {
  return bytes > REPEAT_EVIDENCE_BYTES;
}
export function mapPlanLeaves(steps, map) {
  return steps.map((step) =>
    ["repeat", "if"].includes(step.type)
      ? { ...step, steps: mapPlanLeaves(step.steps, map) }
      : map(step),
  );
}
export function planOccurrences(
  steps,
  { controls = false, runtimeRows = false } = {},
) {
  if (hasRuntimeRows(steps)) {
    if (!runtimeRows || !controls)
      throw Error("运行时数据行循环须由显式启用控制图的执行入口处理");
    // Validate all potential work before allocating the bounded program.
    validateRepeatGraph(steps, { requireIds: true, allowRuntimeRows: true });
  }
  const occurrences = [];
  const visit = (nodes, path, dataContext, runtimeContext) => {
    for (const step of nodes) {
      if (step.enabled === false) continue;
      if (step.type === "if") {
        const control = {
          step,
          ...runtimeContext,
          condition: true,
          ...(dataContext === undefined ? {} : { dataContext }),
          occurrenceId: JSON.stringify([
            "if",
            path.map(({ groupId, iteration }) => [groupId, iteration]),
            step.id,
          ]),
        };
        if (controls) occurrences.push(control);
        visit(step.steps, path, dataContext, runtimeContext);
        control.skipTo = occurrences.length;
        continue;
      }
      if (step.type === "repeat") {
        if (Object.hasOwn(step, "rowsFrom")) {
          const frameId = JSON.stringify([
            "runtime-rows",
            path.map(({ groupId, iteration }) => [groupId, iteration]),
            step.id,
          ]);
          const control = (phase, extra = {}) => ({
            kind: `runtime-rows-${phase}`,
            runtimeRows: true,
            step,
            frameId,
            occurrenceId: JSON.stringify([
              frameId,
              phase,
              extra.iteration ?? null,
            ]),
            ...extra,
          });
          const entry = control("enter");
          occurrences.push(entry);
          const gates = [];
          let previousHasWork = false;
          for (let iteration = 0; iteration < step.maxRows; iteration++) {
            const context = {
              runtimeFrameId: frameId,
              runtimeIteration: iteration,
            };
            const gate = control("gate", { iteration, ...context });
            gates.push(gate);
            occurrences.push(gate);
            if (iteration && previousHasWork && step.intervalMs)
              occurrences.push({
                wait: true,
                milliseconds: step.intervalMs,
                ...context,
              });
            const before = occurrences.length;
            visit(
              step.steps,
              [...path, { groupId: step.id, iteration }],
              undefined,
              context,
            );
            previousHasWork = occurrences.length > before;
          }
          entry.exitTo = occurrences.length;
          for (const gate of gates) gate.exitTo = occurrences.length;
          occurrences.push(control("exit"));
          continue;
        }
        let previousHasWork = false;
        const untilControls = [];
        for (let iteration = 0; iteration < step.count; iteration++) {
          if (controls && iteration && previousHasWork && step.intervalMs)
            occurrences.push({
              wait: true,
              milliseconds: step.intervalMs,
              ...runtimeContext,
            });
          const before = occurrences.length;
          visit(
            step.steps,
            [...path, { groupId: step.id, iteration }],
            step.rows === undefined
              ? dataContext
              : {
                  iteration,
                  iterationCount: step.count,
                  iterationData: step.rows[iteration],
                },
            runtimeContext,
          );
          previousHasWork = occurrences.length > before;
          if (controls && Object.hasOwn(step, "untilCondition")) {
            const iterationContext =
              step.rows === undefined
                ? dataContext
                : {
                    iteration,
                    iterationCount: step.count,
                    iterationData: step.rows[iteration],
                  };
            const control = {
              step,
              ...runtimeContext,
              condition: true,
              until: true,
              iteration,
              lastIteration: iteration === step.count - 1,
              ...(iterationContext === undefined
                ? {}
                : { dataContext: iterationContext }),
              occurrenceId: JSON.stringify([
                "repeat-until",
                path.map(({ groupId, iteration }) => [groupId, iteration]),
                step.id,
                iteration,
              ]),
            };
            occurrences.push(control);
            untilControls.push(control);
            previousHasWork = true;
          }
        }
        for (const control of untilControls)
          control.skipTo = occurrences.length;
        continue;
      }
      if (!path.length) {
        occurrences.push({
          step,
          ...runtimeContext,
          ...(dataContext === undefined ? {} : { dataContext }),
        });
        continue;
      }
      const { groupId, iteration } = path.at(-1);
      occurrences.push({
        step,
        ...runtimeContext,
        ...(dataContext === undefined ? {} : { dataContext }),
        repeat: {
          groupId,
          childId: step.id,
          iteration,
          // Preserve the legacy tuple byte-for-byte; nested tuples start with
          // an array, so the two identity domains cannot collide.
          occurrenceId: JSON.stringify(
            path.length === 1
              ? [groupId, step.id, iteration]
              : [
                  path.map(({ groupId, iteration }) => [groupId, iteration]),
                  step.id,
                ],
          ),
          ...(path.length > 1
            ? { path: path.map((entry) => ({ ...entry })) }
            : {}),
        },
      });
    }
  };
  visit(steps, [], undefined);
  return occurrences;
}
export function activePlanStepCount(plan) {
  validateRepeatGraph(plan.steps, { requireIds: true });
  return planOccurrences(plan.steps).length;
}

export function hasIfSteps(steps) {
  return steps.some(
    (step) =>
      step.type === "if" || (step.type === "repeat" && hasIfSteps(step.steps)),
  );
}
// Conditional safety, authorization, and progress must include repeat tails.
export function hasPlanConditions(steps) {
  return steps.some(
    (step) =>
      step.type === "if" ||
      (step.type === "repeat" &&
        (Object.hasOwn(step, "untilCondition") ||
          hasPlanConditions(step.steps))),
  );
}

// Runtime safety checks apply to enabled groups only; disabled definitions are
// still validated and counted by validateRepeatGraph.
export function hasRepeatUntil(steps) {
  return steps.some(
    (step) =>
      step.enabled !== false &&
      ["repeat", "if"].includes(step.type) &&
      ((step.type === "repeat" && Object.hasOwn(step, "untilCondition")) ||
        hasRepeatUntil(step.steps)),
  );
}
