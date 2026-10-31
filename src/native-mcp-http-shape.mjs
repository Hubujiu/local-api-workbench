// Native flow definitions are HTTP-only. Do not erase canonical protocol state.
const protocolFields = [
  "grpc",
  "socketio",
  "protocol",
  "grpcResult",
  "socketioResult",
  "protocolResult",
];
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonHTTP = (value) =>
  (value.type !== undefined && value.type !== "http") ||
  protocolFields.some((key) => Object.hasOwn(value, key)) ||
  (value.repeat !== undefined && value.repeat !== null);
const planError = () => {
  throw Error("原版兼容流程仅支持HTTP步骤；请使用canonical计划工具");
};
const resultError = () => {
  throw Error("原版兼容结果不支持非HTTP或无效步骤；请使用canonical结果工具");
};
export function assertNativeHTTPPlan(plan) {
  if (!object(plan) || !Array.isArray(plan.steps)) planError();
  for (const step of plan.steps) {
    if (
      !object(step) ||
      nonHTTP(step) ||
      Object.hasOwn(step, "steps") ||
      !object(step.request)
    )
      planError();
  }
}
export function assertNativeHTTPResult(run) {
  if (!object(run) || nonHTTP(run)) resultError();
  if (run.snapshot !== undefined && run.snapshot !== null) {
    if (!object(run.snapshot) || nonHTTP(run.snapshot)) resultError();
    if (Object.hasOwn(run.snapshot, "steps")) {
      try {
        assertNativeHTTPPlan(run.snapshot);
      } catch {
        resultError();
      }
    }
  }
  if (run.results !== undefined) {
    if (!Array.isArray(run.results)) resultError();
    for (const record of run.results)
      if (!object(record) || nonHTTP(record)) resultError();
  }
  // Old sparse HTTP histories need not contain request/snapshot identity.
  // Keep existing counts, never synthesize missing request IDs or protocol data.
}
