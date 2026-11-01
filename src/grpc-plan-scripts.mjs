import { validateCollectionScope } from "./postman-collection-scopes.mjs";
import {
  grpcScriptContext,
  normalizeGrpcScripts,
} from "./grpc-script-context.mjs";
import { grpcPlanRequest, snapshotGrpcStep } from "./grpc-plan.mjs";
import { effectiveScopes } from "./variable-scopes.mjs";
import { createPlanScriptPhases } from "./plan-script-phases.mjs";

export function validatePlanGrpcScripts(steps) {
  for (const step of steps) {
    if (step.type === "repeat") {
      if (Object.hasOwn(step, "grpcScripts"))
        throw Error("grpcScripts仅可用于gRPC计划步骤");
      validatePlanGrpcScripts(step.steps);
      continue;
    }
    if (!Object.hasOwn(step, "grpcScripts")) continue;
    if (step.type !== "grpc") throw Error("grpcScripts仅可用于gRPC计划步骤");
    const descriptor = Object.getOwnPropertyDescriptor(step, "grpcScripts");
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      throw Error("grpcScripts必须是普通JSON数据字段");
    normalizeGrpcScripts(descriptor.value);
  }
}

// This path is opt-in. Unscripted gRPC and other protocols retain their old path.
export async function runScriptedGrpcStep({
  step,
  record,
  scopes: initialScopes,
  functions,
  executionContext,
  credentials,
  signal,
  executeGrpc,
  interpolate,
  evaluateAssertions,
  extractResponseValue,
  onScopeChanges,
  publishScopes,
}) {
  const validated = snapshotGrpcStep(step);
  if (!executeGrpc) throw Error("此执行入口未授权grpc调用");
  record.type = "grpc";
  record.grpc = structuredClone(validated.grpc);
  const phases = createPlanScriptPhases({
    step,
    record,
    scopes: initialScopes,
    functions,
    executionContext,
    signal,
    onScopeChanges,
    publishScopes,
    scripts: validated.grpcScripts,
    protocolLabel: "gRPC",
    validateScopes: (scopes) => validateCollectionScope(scopes, undefined),
    contextOptions: (phase, messages, result) => ({
      grpcContext: grpcScriptContext(validated, phase, messages, result),
    }),
  });
  const beforeScopes = await phases.script(
    "before",
    structuredClone(phases.scopes),
    validated.grpc.messages,
  );
  if (validated.grpcScripts.before.trim())
    await phases.commit(beforeScopes, undefined, "before");
  phases.cancelled();
  const messages = interpolate(validated.grpc.messages, {
    ...effectiveScopes(phases.scopes),
    ...phases.localVariables,
  });
  // Apply the same message envelope again after interpolation, before transport.
  snapshotGrpcStep({ ...validated, grpc: { ...validated.grpc, messages } });
  record.grpc.messages = structuredClone(messages);
  delete record.scriptPhase;
  const result = await executeGrpc(
    { ...grpcPlanRequest(validated, messages), ...credentials },
    signal,
  );
  record.grpcResult = { ...result, metadata: [], trailers: [] };
  phases.cancelled();
  const evidence = {
    status: result.status.code,
    duration: result.durationMs,
    headers: {},
    body: JSON.stringify(result.messages),
  };
  record.assertions.push(
    ...evaluateAssertions(evidence, validated.assertions).map((assertion) => ({
      ...assertion,
      phase: "response",
    })),
  );
  const nextScopes = await phases.script(
    "after",
    structuredClone(phases.scopes),
    messages,
    result,
  );
  if (
    result.status.code !== validated.expectedStatus ||
    record.assertions.some((test) => !test.passed)
  ) {
    record.status = "failed";
    return;
  }
  delete record.scriptPhase;
  const extracted = {};
  for (const extraction of validated.extract) {
    const value = extractResponseValue(evidence, extraction);
    const destination = extraction.scope || "runtime";
    if (destination === "runtime") {
      nextScopes.runtime[extraction.name] = value;
      nextScopes.hidden = nextScopes.hidden.filter(
        (name) => name !== extraction.name,
      );
    } else if (destination === "environment")
      nextScopes.environment[extraction.name] = value;
    else nextScopes.globals[extraction.name] = value;
    extracted[extraction.name] = value;
  }
  await phases.commit(nextScopes, extracted, "after");
  record.status = "passed";
}
