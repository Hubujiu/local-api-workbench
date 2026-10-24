import { jsonPathSegments } from "./json-path.mjs";
import { grpcTransport, normalizeGrpcDefinition } from "./grpc.mjs";
import { grpcSource } from "./grpc-schema.mjs";
const plain = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
export function snapshotGrpcStep(step) {
  const keys = [
    "type",
    "id",
    "name",
    "enabled",
    "grpc",
    "extract",
    "assertions",
    "expectedStatus",
  ];
  if (Object.keys(step).some((key) => !keys.includes(key)))
    throw Error("gRPC计划暂不支持额外字段、脚本或保存凭据");
  if (
    !plain(step.grpc) ||
    Object.keys(step.grpc).some(
      (key) => !["definition", "messages"].includes(key),
    )
  )
    throw Error("gRPC计划需要冻结定义，不保存额外凭据");
  const definition = normalizeGrpcDefinition(step.grpc.definition);
  if (!definition.service || !definition.method)
    throw Error("gRPC计划必须选定服务和方法");
  const messages = step.grpc.messages ?? [{}];
  if (
    !Array.isArray(messages) ||
    messages.length > 100 ||
    messages.some((x) => !plain(x)) ||
    Buffer.byteLength(JSON.stringify(messages)) > 1024 * 1024
  )
    throw Error("gRPC计划消息无效或超限");
  const expectedStatus = step.expectedStatus ?? 0;
  if (
    !Number.isInteger(expectedStatus) ||
    expectedStatus < 0 ||
    expectedStatus > 16
  )
    throw Error("gRPC预期状态必须为0至16");
  const extract = step.extract ?? [],
    assertions = step.assertions ?? [];
  if (
    !Array.isArray(extract) ||
    extract.length > 100 ||
    !Array.isArray(assertions) ||
    assertions.length > 100
  )
    throw Error("gRPC提取与断言最多100项");
  for (const item of extract) {
    if (
      !plain(item) ||
      Object.keys(item).some((k) => !["name", "path", "scope"].includes(k)) ||
      typeof item.path !== "string" ||
      item.path.length > 1000 ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 100 ||
      ["__proto__", "prototype", "constructor"].includes(item.name) ||
      (item.scope !== undefined &&
        !["runtime", "environment", "global"].includes(item.scope))
    )
      throw Error("gRPC提取只支持消息JSON路径和有效变量作用域");
    const segments = jsonPathSegments(item.path);
    if (
      segments.some((x) =>
        ["__proto__", "prototype", "constructor"].includes(x),
      )
    )
      throw Error("禁止的gRPC提取路径");
  }
  for (const item of assertions) {
    if (
      !plain(item) ||
      Object.keys(item).some((k) => !["target", "op", "value"].includes(k)) ||
      typeof item.target !== "string" ||
      !(
        item.target === "status" ||
        item.target === "duration" ||
        item.target.startsWith("$")
      ) ||
      !["eq", "neq", "contains", "exists", "lt", "gt"].includes(item.op)
    )
      throw Error("gRPC断言只支持原生状态、耗时和消息JSON路径");
    if (item.target.startsWith("$")) jsonPathSegments(item.target);
  }
  return {
    ...structuredClone(step),
    type: "grpc",
    grpc: { definition, messages: structuredClone(messages) },
    extract: structuredClone(extract),
    assertions: structuredClone(assertions),
    expectedStatus,
  };
}
export function freezeGrpcStep(project, step) {
  if (!step.grpc?.definitionId) return step;
  if (step.grpc.definition) throw Error("gRPC计划不能同时提供定义与引用");
  const definition = (project.settings?.grpcDefinitions || []).find(
    (x) => x.id === step.grpc.definitionId,
  );
  if (!definition) throw Error("项目gRPC定义不存在");
  const { definitionId, ...rest } = step.grpc;
  return {
    ...step,
    grpc: { ...rest, definition: structuredClone(definition) },
  };
}
export function grpcPlanRequest(step, messages) {
  const d = step.grpc.definition;
  return {
    target: d.target,
    ...grpcSource(d),
    service: d.service,
    method: d.method,
    timeoutMs: d.timeoutMs,
    messages,
  };
}

export function grpcPlanCredentials(plan, input = {}) {
  if (
    !plain(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024
  )
    throw Error("gRPC临时凭据映射无效或超限");
  const bindings = new Map();
  for (const [stepId, value] of Object.entries(input)) {
    const steps = plan.steps.filter((step) => step.id === stepId);
    if (
      steps.length !== 1 ||
      steps[0]?.type !== "grpc" ||
      ["__proto__", "constructor", "prototype"].includes(stepId)
    )
      throw Error("gRPC临时凭据步骤不存在或不唯一");
    if (
      !plain(value) ||
      Object.keys(value).some((key) => !["metadata", "tls"].includes(key))
    )
      throw Error("gRPC临时凭据仅支持metadata与tls，不能覆盖目标或定义");
    grpcTransport(steps[0].grpc.definition.target, value);
    bindings.set(stepId, structuredClone(value));
  }
  return bindings;
}
