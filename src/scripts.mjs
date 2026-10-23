import { finalBodyLiteral } from "./script-final-body.mjs";
import { normalizeScriptURLMode } from "../public/script-url-mode.js";
import {
  initializeQueryRuntime,
  validateQueryRuntime,
} from "./script-url-runtime.mjs";
import { validateResponseMutation } from "./script-response-mutation.mjs";
import { compileTrackedQuickJS } from "./tracked-quickjs.mjs";
import { normalizeScriptDialect } from "../public/script-dialect.js";
import { normalizeExecutionContext } from "./script-context.mjs";
import { validateResources } from "./resources.mjs";
import { Worker } from "node:worker_threads";

// Application startup only; each worker receives immutable compiled code, never a shared VM.
const compiledEngine = await compileTrackedQuickJS();

/** QuickJS has no Node bindings; explicit callback HTTP is brokered by the parent. */
export function runScript(
  code,
  input,
  {
    signal,
    cookieSession,
    activityBudgetMs = 250,
    wallBudgetMs = 2000,
    requestLimit = 10,
    timerLimit = 100,
    fakerLimit = 1000,
    jobLimit = 10000,
    assertionLimit = 1000,
  } = {},
) {
  if (
    !Number.isFinite(activityBudgetMs) ||
    activityBudgetMs <= 0 ||
    activityBudgetMs > 250 ||
    !Number.isFinite(wallBudgetMs) ||
    wallBudgetMs <= 0 ||
    wallBudgetMs > 2000 ||
    !Number.isInteger(requestLimit) ||
    requestLimit < 0 ||
    requestLimit > 10
  )
    throw Error("脚本预算无效");
  for (const [limit, max] of [
    [timerLimit, 100],
    [fakerLimit, 1000],
    [jobLimit, 10000],
    [assertionLimit, 1000],
  ])
    if (!Number.isInteger(limit) || limit < 0 || limit > max)
      throw Error("脚本预算无效");
  if (input.finalBody !== undefined)
    finalBodyLiteral(input.finalBody, input.request || {});
  normalizeScriptDialect(input.request?.scriptDialect);
  const urlMode = normalizeScriptURLMode(input.request?.scriptURLMode);
  if (input.request?.scriptURLRuntime !== undefined && urlMode !== "sdk")
    throw Error("URL状态仅可用于SDK模式");
  if (urlMode === "sdk")
    input = {
      ...input,
      request: {
        ...input.request,
        scriptURLRuntime:
          input.request.scriptURLRuntime !== undefined
            ? validateQueryRuntime(input.request.scriptURLRuntime)
            : initializeQueryRuntime(input.request),
      },
    };
  input = {
    ...input,
    executionContext: normalizeExecutionContext(input.executionContext),
    responseOriginals: validateResponseMutation(
      input.responseOriginals,
      Boolean(input.response),
      true,
    ),
  };
  validateResources({ functions: input.functions || [] });
  if (typeof code !== "string" || code.length > 100000)
    throw Error("脚本不能超过 100 KB");
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Error("脚本执行已取消"));
      return;
    }
    const worker = new Worker(new URL("./script-worker.mjs", import.meta.url), {
      workerData: {
        compiledEngine,
        code,
        input,
        activityBudgetMs,
        requestLimit,
        timerLimit,
        fakerLimit,
        jobLimit,
        assertionLimit,
      },
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
    });
    const controller = new AbortController(),
      networkRequests = [];
    let completedMessage,
      settled = false,
      total = 0,
      active = 0;
    const finish = async (error, result, terminate = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      controller.abort();
      if (terminate) await worker.terminate();
      if (error) {
        for (const record of networkRequests)
          if (record.status === "running") {
            record.status = "interrupted";
            record.error = error.message;
          }
        error.networkRequests = structuredClone(networkRequests);
        reject(error);
      } else {
        try {
          resolve({
            ...result,
            responseOverride: validateResponseMutation(
              result.responseOverride,
              Boolean(input.response),
            ),
            responseOriginals: validateResponseMutation(
              result.responseOriginals,
              Boolean(input.response),
              true,
            ),
            networkRequests,
          });
        } catch (error) {
          error.scriptStage = "response-override";
          error.networkRequests = structuredClone(networkRequests);
          reject(error);
        }
      }
    };
    const startedAt = performance.now();
    let lastWorkerStage = "starting";
    const timer = setTimeout(
      () =>
        finish(
          Object.assign(Error("脚本执行超时"), {
            scriptStage: "total-deadline",
            lastWorkerStage,
            elapsedMs: Math.round(performance.now() - startedAt),
          }),
        ),
      wallBudgetMs,
    );
    const cancel = () =>
      finish(
        Object.assign(Error("脚本执行已取消"), { scriptStage: "cancelled" }),
      );
    signal?.addEventListener("abort", cancel, { once: true });
    worker.on("message", async (message) => {
      if (settled) return;
      if (message.kind === "stage") {
        lastWorkerStage = message.stage;
        return;
      }
      if (message.kind === "http") {
        if (!input.allowNetwork) {
          finish(Error("此脚本未启用HTTP网络能力"));
          return;
        }
        if (++total > requestLimit || active >= 4) {
          finish(Error("脚本HTTP最多10次、同时4次"));
          return;
        }
        active++;
        let request, response, error;
        const evidence = { status: "running", request: null };
        networkRequests.push(evidence);
        try {
          const { scriptHTTPRequest } = await import("./script-http.mjs");
          const { executeRequest } = await import("./runtime.mjs");
          if (settled) return;
          const payload = JSON.parse(message.payload);
          request = scriptHTTPRequest(payload.request, payload.variables);
          evidence.request = {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body,
            form: request.form,
          };
          response = await executeRequest(request, controller.signal, {
            cookieSession,
          });
          response = {
            status: response.status,
            statusText: response.statusText,
            duration: response.duration,
            size: response.size,
            headers: response.headers,
            body: response.body,
            ...(response.cookieError
              ? { cookieError: response.cookieError }
              : {}),
          };
          if (Buffer.byteLength(JSON.stringify(response)) > 262144) {
            response = undefined;
            throw Error("脚本HTTP响应超过256KiB");
          }
        } catch (e) {
          error = String(e.message).slice(0, 2000);
        } finally {
          active--;
        }
        if (settled) return;
        Object.assign(evidence, {
          status: error ? "failed" : "completed",
          ...(response ? { response } : {}),
          ...(error ? { error } : {}),
        });
        worker.postMessage({ kind: "http", id: message.id, error, response });
      } else completedMessage = message;
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (exitCode) => {
      if (settled) return;
      if (exitCode === 0 && completedMessage) {
        finish(
          completedMessage.error
            ? Object.assign(Error(completedMessage.error), {
                scriptStage: completedMessage.scriptStage,
                scriptDiagnostics: completedMessage.scriptDiagnostics,
                activityOperation: completedMessage.activityOperation,
                activityMetrics: completedMessage.activityMetrics,
              })
            : null,
          completedMessage.result,
          false,
        );
      } else finish(Error("脚本执行进程被终止: " + exitCode), undefined, false);
    });
  });
}

/** Ordered scopes share one phase's existing resource/authority envelope. */
export async function runScriptSequence(stages, input, options = {}) {
  if (
    !Array.isArray(stages) ||
    stages.length > 34 ||
    stages.some(
      (stage) =>
        !stage ||
        typeof stage.name !== "string" ||
        !stage.name ||
        stage.name.length > 200 ||
        typeof stage.code !== "string",
    ) ||
    stages.reduce((sum, stage) => sum + stage.code.length, 0) > 100000
  )
    throw Error("脚本阶段格式无效，最多34阶段、源码合计100000字符");
  const deadline = performance.now() + 2000;
  let remaining = 250,
    requestLimit = 10,
    timerLimit = 100,
    fakerLimit = 1000,
    jobLimit = 10000,
    assertionLimit = 1000,
    state = structuredClone(input);
  state.responseOverride = null;
  state.responseOriginals = null;
  state.responseWire = undefined;
  const logs = [],
    tests = [],
    networkRequests = [];
  for (const stage of stages) {
    if (!stage.code.trim()) continue;
    const wallBudgetMs = Math.min(2000, deadline - performance.now());
    if (remaining <= 0 || wallBudgetMs <= 0)
      throw Object.assign(Error("脚本执行超时"), {
        scriptStage: "sequence-budget",
        networkRequests,
      });
    let result;
    try {
      result = await runScript(stage.code, state, {
        ...options,
        activityBudgetMs: remaining,
        wallBudgetMs,
        requestLimit,
        timerLimit,
        fakerLimit,
        jobLimit,
        assertionLimit,
      });
    } catch (error) {
      error.scriptScope = stage.name;
      error.networkRequests = [
        ...networkRequests,
        ...(error.networkRequests || []).map((item) => ({
          ...item,
          scope: stage.name,
        })),
      ];
      throw error;
    }
    if (result.responseOverride) {
      state.responseWire ??= structuredClone(input.response);
      state.responseOverride = validateResponseMutation(
        { ...state.responseOverride, ...result.responseOverride },
        Boolean(state.response),
      );
      state.response = { ...state.response, ...state.responseOverride };
    }
    state.responseOriginals = result.responseOriginals;
    remaining -= result.activityMs;
    requestLimit -= result.networkRequests.length;
    timerLimit -= result.usage.timers;
    fakerLimit = Math.max(0, fakerLimit - result.usage.fakerCalls);
    jobLimit -= result.usage.jobs;
    assertionLimit -= result.tests.length;
    logs.push(
      ...result.logs
        .slice(0, Math.max(0, 100 - logs.length))
        .map((message) => ("[" + stage.name + "] " + message).slice(0, 2000)),
    );
    tests.push(...result.tests.map((item) => ({ ...item, scope: stage.name })));
    networkRequests.push(
      ...result.networkRequests.map((item) => ({ ...item, scope: stage.name })),
    );
    for (const key of [
      "variables",
      "scopes",
      "localVariables",
      "request",
      "visualization",
      "finalBody",
    ])
      state[key] = result[key];
    if (performance.now() > deadline || remaining < 0)
      throw Object.assign(Error("脚本执行超时"), {
        scriptStage: "sequence-budget",
        networkRequests,
      });
    if (
      Buffer.byteLength(
        JSON.stringify({
          variables: state.variables,
          scopes: state.scopes,
          localVariables: state.localVariables,
          request: state.request,
          visualization: state.visualization,
          finalBody: state.finalBody,
          responseOverride: state.responseOverride,
          responseOriginals: state.responseOriginals,
          logs,
          tests,
        }),
        "utf8",
      ) >
      1024 * 1024
    )
      throw Object.assign(Error("脚本输出超过 1 MiB"), {
        scriptStage: "sequence-output",
        networkRequests,
      });
    if (result.tests.some((item) => !item.passed)) break;
  }
  return {
    variables: state.variables || {},
    scopes: state.scopes,
    localVariables: state.localVariables || {},
    request: state.request,
    ...(state.finalBody === undefined ? {} : { finalBody: state.finalBody }),
    visualization: state.visualization ?? null,
    responseOverride: state.responseOverride,
    responseOriginals: state.responseOriginals,
    logs,
    tests,
    networkRequests,
    activityMs: 250 - remaining,
  };
}
