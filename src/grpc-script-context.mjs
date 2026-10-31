const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const dataKeys = (value, allowed) =>
  plain(value) &&
  Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === "string" &&
      allowed.includes(key) &&
      descriptor.enumerable &&
      Object.hasOwn(descriptor, "value")
    );
  });

export function normalizeGrpcScripts(value) {
  if (value === undefined) return undefined;
  if (
    !dataKeys(value, ["version", "before", "after"]) ||
    value.version !== 1 ||
    Object.keys(value).some(
      (key) => !["version", "before", "after"].includes(key),
    ) ||
    ["before", "after"].some(
      (phase) =>
        value[phase] !== undefined &&
        (typeof value[phase] !== "string" || value[phase].length > 100000),
    )
  )
    throw Error("gRPC脚本需要version:1与最多100000字符的before/after源码");
  return { version: 1, before: value.before ?? "", after: value.after ?? "" };
}

// Only this allowlisted projection enters the VM: no schema or transport secrets.
export function grpcScriptContext(step, phase, messages, result) {
  const definition = step.grpc.definition;
  return normalizeGrpcScriptContext({
    protocol: "grpc",
    phase,
    request: {
      target: definition.target,
      service: definition.service,
      method: definition.method,
      timeoutMs: definition.timeoutMs,
      messages,
    },
    ...(result === undefined
      ? {}
      : {
          result: {
            status: {
              code: result.status.code,
              details: result.status.details,
            },
            messages: result.messages,
            durationMs: result.durationMs,
          },
        }),
  });
}

export function normalizeGrpcScriptContext(value) {
  const keys = dataKeys;
  const safeJSON = (value, depth = 0, budget = { nodes: 0 }) => {
    if (depth > 64 || ++budget.nodes > 20000) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "string") return !/[\uD800-\uDFFF]/u.test(value);
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) return false;
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, "value") ||
          !safeJSON(descriptor.value, depth + 1, budget)
        )
          return false;
      }
      return true;
    }
    if (!plain(value) || !dataKeys(value, Object.keys(value))) return false;
    return Object.entries(value).every(
      ([key, item]) =>
        !["__proto__", "prototype", "constructor"].includes(key) &&
        safeJSON(item, depth + 1, budget),
    );
  };
  const messages = (items) =>
    Array.isArray(items) &&
    items.length <= 100 &&
    safeJSON(items) &&
    items.every(plain) &&
    Buffer.byteLength(JSON.stringify(items)) <= 1024 * 1024;
  if (
    !keys(value, ["protocol", "phase", "request", "result"]) ||
    value.protocol !== "grpc" ||
    !["before", "after"].includes(value.phase) ||
    !keys(value.request, [
      "target",
      "service",
      "method",
      "timeoutMs",
      "messages",
    ]) ||
    ["target", "service", "method"].some(
      (key) =>
        typeof value.request[key] !== "string" ||
        value.request[key].length > 2048,
    ) ||
    !Number.isInteger(value.request.timeoutMs) ||
    value.request.timeoutMs < 50 ||
    value.request.timeoutMs > 30000 ||
    !messages(value.request.messages) ||
    (value.phase === "before"
      ? value.result !== undefined
      : !keys(value.result, ["status", "messages", "durationMs"]) ||
        !keys(value.result.status, ["code", "details"]) ||
        !Number.isInteger(value.result.status.code) ||
        value.result.status.code < 0 ||
        value.result.status.code > 16 ||
        typeof value.result.status.details !== "string" ||
        value.result.status.details.length > 2000 ||
        !Number.isFinite(value.result.durationMs) ||
        value.result.durationMs < 0 ||
        !messages(value.result.messages))
  )
    throw Error("gRPC脚本上下文无效或超限");
  return JSON.parse(JSON.stringify(value));
}

// Serialized into the existing QuickJS VM; never a host callback or a new VM.
function installGrpcScriptContext({ context, pm, apt, request }) {
  const freeze = (value) => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  const view = freeze(context);
  const unavailable = () => {
    throw Error("gRPC脚本不支持HTTP请求/响应修改或附加网络调用");
  };
  const allowed = [
    "variables",
    "environment",
    "globals",
    "test",
    "expect",
    "info",
    "iterationData",
    "setVar",
    "getVar",
  ];
  for (const api of [pm, apt]) {
    for (const key of Object.keys(api))
      if (!allowed.includes(key))
        api[key] = ["request", "response", "cookies"].includes(key)
          ? undefined
          : unavailable;
    api.info = Object.freeze({
      ...api.info,
      protocol: "grpc",
      eventName: context.phase === "before" ? "prerequest" : "test",
    });
    Object.defineProperty(api, "grpc", { value: view, enumerable: true });
    Object.freeze(api);
  }
  freeze(request);
  Object.defineProperty(globalThis, "grpc", { value: view, enumerable: true });
}
export const grpcScriptContextSource = installGrpcScriptContext.toString();

// Shared host/worker admission guard. An input JSON field never selects a mode.
export function validateGrpcScriptBinding(input, requestLimit) {
  if (
    Object.hasOwn(input, "grpcContext") ||
    input.allowNetwork ||
    requestLimit !== 0 ||
    input.response !== undefined ||
    input.finalBody !== undefined ||
    input.responseOriginals != null ||
    input.responseWire !== undefined ||
    !dataKeys(input.request || {}, ["id", "name"])
  )
    throw Error("gRPC脚本不能绑定HTTP网络或响应能力");
}
