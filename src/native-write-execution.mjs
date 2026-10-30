import { randomUUID } from "node:crypto";
import { observeNativeRedisSet } from "./redis.mjs";
import {
  nativeWriteDigest,
  collectNativeRedisWrites,
} from "./native-redis-write-intent.mjs";
import { databaseWriteReceipt } from "./database-write-receipts.mjs";

const executions = new WeakMap();
const denied = () =>
  Object.assign(Error("原生写入授权与冻结请求不匹配"), {
    code: "NATIVE_WRITE_AUTHORITY_REQUIRED",
  });
export function createNativeWriteExecution(handle, target, { signal } = {}) {
  const writes = handle.snapshot.plan.steps
    .filter((step) => step.enabled !== false)
    .flatMap((step) => collectNativeRedisWrites(step.request));
  if (writes.length !== 1 || handle.snapshot.plan.steps.length !== 1)
    throw denied();
  const intent = writes[0],
    capability = Object.freeze({});
  const identity = {
    runId: handle.runId,
    preparationId: handle.preparationId,
    projectId: handle.projectId,
    receiptId: randomUUID(),
    phase: intent.phase,
    ordinal: intent.ordinal,
    ...(intent.taskId ? { taskId: intent.taskId } : {}),
    connectionId: intent.connectionId,
    commandDigest: intent.commandDigest,
  };
  executions.set(capability, {
    handle,
    target,
    signal,
    intent,
    identity,
    planDigest: nativeWriteDigest(handle.snapshot.plan),
    pending: null,
    receipt: null,
    started: false,
    finalized: false,
  });
  return capability;
}
export function assertNativeWritePlan(capability, plan) {
  const owned = executions.get(capability);
  if (!owned || nativeWriteDigest(plan) !== owned.planDigest) throw denied();
  owned.handle.assertLive();
  owned.target.assertLive();
}
export function executeNativeWrite(
  capability,
  operation,
  phase,
  ordinal,
  signal,
) {
  const owned = executions.get(capability);
  if (
    !owned ||
    owned.started ||
    owned.finalized ||
    phase !== owned.intent.phase ||
    ordinal !== owned.intent.ordinal ||
    operation.connectionId !== owned.intent.connectionId ||
    operation.query !== owned.intent.query ||
    operation.writeIntent !== "redis-set"
  )
    throw denied();
  owned.started = true;
  const effectiveSignal = AbortSignal.any(
    [signal, owned.handle.signal, owned.target.signal].filter(Boolean),
  );
  owned.pending = (async () => {
    const outcome = await observeNativeRedisSet(
      { ...owned.target.config, command: JSON.parse(owned.intent.query) },
      {
        signal: effectiveSignal,
        beforeDispatch() {
          owned.target.assertLive();
          owned.handle.assertLive();
          owned.handle.consume();
        },
      },
    );
    owned.receipt = databaseWriteReceipt(
      owned.identity,
      outcome.outcome,
      outcome.reason,
    );
    return outcome;
  })();
  return owned.pending.then((outcome) => {
    if (outcome.outcome !== "acknowledged-applied" || effectiveSignal.aborted)
      throw Object.assign(
        Error("原生写入未获得可继续执行的确认；请检查写入凭据，勿重放"),
        { code: "NATIVE_WRITE_STOPPED" },
      );
    return outcome.result;
  });
}
export async function finishNativeWrite(capability) {
  const owned = executions.get(capability);
  if (!owned) throw denied();
  owned.finalized = true;
  if (owned.pending) await owned.pending;
  if (!owned.receipt)
    owned.receipt = databaseWriteReceipt(
      owned.identity,
      "not-sent",
      owned.handle.signal.aborted || owned.target.signal.aborted
        ? "revoked"
        : owned.signal?.aborted
          ? "cancelled"
          : "not-reached",
    );
  return [owned.receipt];
}
export async function drainNativeWrite(capability) {
  const owned = executions.get(capability);
  if (!owned) throw denied();
  if (owned.pending) await owned.pending;
}
