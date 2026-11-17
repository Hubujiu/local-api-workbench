import { runScript } from "./scripts.mjs";
import {
  createScopes,
  effectiveScopes,
  scopeChanges,
} from "./variable-scopes.mjs";
import { ProjectCommitUncertain } from "./project-commit-outcome.mjs";

// Shared lifecycle only. Each native protocol keeps its own request, evidence,
// expected status and extraction rules; no HTTP response is constructed here.
export function createPlanScriptPhases({
  step,
  record,
  scopes: initialScopes,
  functions,
  executionContext,
  signal,
  onScopeChanges,
  publishScopes,
  scripts,
  contextOptions,
  protocolLabel,
  validateScopes,
}) {
  let scopes = structuredClone(initialScopes),
    localVariables = {};
  const cancelled = () => {
    if (signal?.aborted)
      throw Error(`执行已取消，未开始新的${protocolLabel}脚本或变量提交`);
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
            `${protocolLabel}脚本变量持久化提交未确认；请重新读取项目，勿自动重试`,
          );
        }
        throw Error(
          `${protocolLabel}脚本变量持久化失败；未采纳本阶段变量，勿重放已完成请求`,
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
  const script = async (phase, state, ...contextArguments) => {
    const code = scripts[phase];
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
        request: { id: String(step.id || ""), name: String(step.name || "") },
      },
      {
        signal,
        requestLimit: 0,
        ...contextOptions(phase, ...contextArguments),
      },
    );
    record.logs.push(...scripted.logs.map((message) => ({ phase, message })));
    record.assertions.push(
      ...scripted.tests.map((test) => ({ ...test, phase })),
    );
    cancelled();
    if (scripted.tests.some((test) => !test.passed))
      throw Error(
        phase === "before"
          ? `${protocolLabel}前置脚本断言失败`
          : `${protocolLabel}后置脚本断言失败`,
      );
    delete record.scriptPhase;
    localVariables = structuredClone(scripted.localVariables || {});
    validateScopes?.(scripted.scopes);
    return createScopes(scripted.variables, scripted.scopes);
  };
  return {
    get scopes() {
      return scopes;
    },
    get localVariables() {
      return localVariables;
    },
    cancelled,
    commit,
    script,
  };
}
