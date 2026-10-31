import { runScript } from "./scripts.mjs";
import {
  grpcScriptContext,
  normalizeGrpcScripts,
} from "./grpc-script-context.mjs";
import { grpcPlanRequest, snapshotGrpcStep } from "./grpc-plan.mjs";
import {
  createScopes,
  effectiveScopes,
  scopeChanges,
} from "./variable-scopes.mjs";
import { ProjectCommitUncertain } from "./project-commit-outcome.mjs";

export function validatePlanGrpcScripts(steps) {
  for (const step of steps) {
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
  let scopes = structuredClone(initialScopes),
    localVariables = {};
  const cancelled = () => {
    if (signal?.aborted)
      throw Error("执行已取消，未开始新的gRPC脚本或变量提交");
  };
  const commit = async (nextScopes, extracted, phase) => {
    cancelled();
    record.scriptPhase = phase;
    const changes = scopeChanges(scopes, nextScopes);
    if (changes.length && onScopeChanges) {
      try {
        const accepted = await onScopeChanges(changes, signal);
        if (accepted?.globals && accepted?.environment) {
          nextScopes.globals = accepted.globals;
          nextScopes.environment = accepted.environment;
        }
      } catch (error) {
        if (
          error instanceof ProjectCommitUncertain ||
          error?.code === "PROJECT_COMMIT_UNCERTAIN"
        ) {
          record.scopeCommit = { outcome: "unknown", retrySafe: false, phase };
          throw Error(
            "gRPC脚本变量持久化提交未确认；请重新读取项目，勿自动重试",
          );
        }
        throw Error(
          "gRPC脚本变量持久化失败；未采纳本阶段变量，勿重放已完成请求",
        );
      }
    }
    // A confirmed write remains committed even if cancelled during acknowledgement.
    scopes = nextScopes;
    publishScopes(scopes);
    if (extracted) record.extracted = extracted;
    delete record.scriptPhase;
    for (const change of changes)
      record.logs.push({
        phase: "variables",
        scriptPhase: phase,
        scope: change.scope,
        name: change.name,
        operation: change.after.exists ? "set" : "unset",
      });
  };
  const script = async (phase, state, messages, result) => {
    const code = validated.grpcScripts[phase];
    if (!code.trim()) return state;
    cancelled();
    record.scriptPhase = phase;
    const scripted = await runScript(
      code,
      {
        allowNetwork: false,
        executionContext,
        variables: effectiveScopes(state),
        scopes: state,
        localVariables,
        functions,
        request: { id: step.id, name: step.name },
      },
      {
        signal,
        requestLimit: 0,
        grpcContext: grpcScriptContext(validated, phase, messages, result),
      },
    );
    record.logs.push(...scripted.logs.map((message) => ({ phase, message })));
    record.assertions.push(
      ...scripted.tests.map((test) => ({ ...test, phase })),
    );
    cancelled();
    if (scripted.tests.some((test) => !test.passed))
      throw Error(
        phase === "before" ? "gRPC前置脚本断言失败" : "gRPC后置脚本断言失败",
      );
    delete record.scriptPhase;
    localVariables = structuredClone(scripted.localVariables || {});
    return createScopes(scripted.variables, scripted.scopes);
  };
  const beforeScopes = await script(
    "before",
    structuredClone(scopes),
    validated.grpc.messages,
  );
  if (validated.grpcScripts.before.trim())
    await commit(beforeScopes, undefined, "before");
  cancelled();
  const messages = interpolate(validated.grpc.messages, {
    ...effectiveScopes(scopes),
    ...localVariables,
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
  cancelled();
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
  const nextScopes = await script(
    "after",
    structuredClone(scopes),
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
  await commit(nextScopes, extracted, "after");
  record.status = "passed";
}
