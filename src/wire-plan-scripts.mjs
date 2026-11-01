import { wireScriptContext } from "./wire-script-context.mjs";
import { snapshotWireStep, resolveWirePlanPayload } from "./wire-plan.mjs";
import { protocolPayload } from "./protocol-payload.mjs";
import { effectiveScopes } from "./variable-scopes.mjs";
import { createPlanScriptPhases } from "./plan-script-phases.mjs";

export async function runScriptedWireStep({
  step,
  record,
  scopes,
  functions,
  executionContext,
  credentials,
  signal,
  executeProtocol,
  interpolate,
  evaluateAssertions,
  extractResponseValue,
  onScopeChanges,
  publishScopes,
}) {
  const validated = snapshotWireStep(step);
  if (!executeProtocol) throw Error("此执行入口未授权protocol调用");
  record.type = "protocol";
  record.protocol = structuredClone(validated.protocol);
  const phases = createPlanScriptPhases({
    step,
    record,
    scopes,
    functions,
    executionContext,
    signal,
    onScopeChanges,
    publishScopes,
    scripts: validated.protocolScripts,
    protocolLabel: "协议",
    contextOptions: (phase, protocol, result) => ({
      wireContext: wireScriptContext(protocol, phase, result),
    }),
  });
  const beforeScopes = await phases.script(
    "before",
    structuredClone(phases.scopes),
    validated.protocol,
  );
  if (validated.protocolScripts.before.trim())
    await phases.commit(beforeScopes, undefined, "before");
  phases.cancelled();
  const protocol = resolveWirePlanPayload(
    validated.protocol,
    {
      ...effectiveScopes(phases.scopes),
      ...phases.localVariables,
    },
    interpolate,
  );
  // Recheck the exact resolved envelope/bytes before starting the frozen target.
  snapshotWireStep({ ...validated, protocol });
  if (protocol.definition.type !== "sse") protocolPayload(protocol.message);
  record.protocol = structuredClone(protocol);
  delete record.scriptPhase;
  const result = await executeProtocol({ ...protocol, ...credentials }, signal);
  // Preserve transport evidence before context admission or POST can fail.
  record.protocolResult = result;
  phases.cancelled();
  if (result.status === "cancelled")
    throw Error("协议执行已取消，未开始后置脚本或变量提交");
  const evidence = {
    status: result.status,
    duration: result.durationMs,
    headers: {},
    body: JSON.stringify(result.result),
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
    protocol,
    result,
  );
  if (
    result.status !== validated.expectedStatus ||
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
