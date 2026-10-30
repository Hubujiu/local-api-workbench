import { compileNativeWaits } from "./native-wait-tasks.mjs";
import {
  compileNativeAssertions,
  isNativeVariableAssertion,
} from "./native-response-assertions.mjs";
import {
  readResponseHeaderEvidence,
  readResponseCookieEvidence,
} from "./response-header-evidence.mjs";
import { nativeRequestSnapshotInput } from "./native-request-snapshot.mjs";
import {
  compilePickVarsOperations,
  isNativeRequestPick,
} from "./native-response-extraction.mjs";
import {
  executeNativeWrite,
  drainNativeWrite,
} from "./native-write-execution.mjs";
import {
  normalizeDatabaseOperations,
  databaseAssignments,
  databaseResultRows,
} from "./script-database-tasks.mjs";
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

function scriptBudgets({
  activityBudgetMs = 250,
  wallBudgetMs = 2000,
  requestLimit = 10,
  timerLimit = 100,
  fakerLimit = 1000,
  jobLimit = 10000,
  assertionLimit = 1000,
} = {}) {
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
  return {
    activityBudgetMs,
    wallBudgetMs,
    requestLimit,
    timerLimit,
    fakerLimit,
    jobLimit,
    assertionLimit,
  };
}

/** QuickJS has no Node bindings; explicit callback HTTP is brokered by the parent. */
export function runScript(code, input, options = {}) {
  const {
    signal,
    cookieSession,
    databaseQuery,
    nativeWrite,
    nativePhase,
    databaseOrdinals,
  } = options;
  const nativeWaits = compileNativeWaits(options.nativeWaits);
  const responseAssertions = compileNativeAssertions(
    options.responseAssertions,
  );
  if (
    responseAssertions.some((op) => !isNativeVariableAssertion(op.type)) &&
    !input.response
  )
    throw Error("原生断言需要后置响应");
  const responseExtractions = compilePickVarsOperations(
    options.responseExtractions,
  );
  if (
    responseExtractions.some((operation) =>
      isNativeRequestPick(operation.source)
        ? Boolean(input.response)
        : !input.response,
    )
  )
    throw Error("请求pickVars仅支持前置阶段，响应pickVars仅支持后置响应");
  const requestSources = responseExtractions
    .map((operation) => operation.source)
    .filter(isNativeRequestPick);
  const requestSnapshot = requestSources.length
    ? nativeRequestSnapshotInput(input.request || {}, requestSources)
    : undefined;
  const databaseOperations = normalizeDatabaseOperations(
    options.databaseOperations,
  );
  if (
    databaseOperations.some((operation) => operation.writeIntent) &&
    !nativeWrite
  )
    throw Error("此执行入口未授权原生写入");
  if (databaseOperations.length && typeof databaseQuery !== "function")
    throw Error("此执行入口未授权数据库任务");
  const {
    activityBudgetMs,
    wallBudgetMs,
    requestLimit,
    timerLimit,
    fakerLimit,
    jobLimit,
    assertionLimit,
  } = scriptBudgets(options);
  if (responseAssertions.length > assertionLimit)
    throw Error("声明的原生断言超过本次共享断言预算");

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
        databaseTaskCount: databaseOperations.length,
        responseExtractions,
        requestSnapshot,
        responseAssertions,
        nativeWaits,
        // Never trust serialized fields supplied by a request, response or VM.
        responseHeaderEvidence: readResponseHeaderEvidence(input.response),
        responseCookieEvidence: readResponseCookieEvidence(input.response),
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
      networkRequests = [],
      databaseQueries = [];
    let nextDatabase = 0,
      databaseActive = false;
    let completedMessage,
      settled = false,
      total = 0,
      active = 0;
    let finishing;
    const finish = (error, result, terminate = true) => {
      if (finishing) return finishing;
      settled = true;
      finishing = Promise.resolve()
        .then(async () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          controller.abort();
          for (const record of databaseQueries)
            if (record.status === "running") record.status = "interrupted";
          if (terminate) await worker.terminate();
          if (nativeWrite) await drainNativeWrite(nativeWrite);
          if (error) {
            error.elapsedMs ??= Math.round(performance.now() - startedAt);
            error.lastWorkerStage ??= lastWorkerStage;
            for (const record of networkRequests)
              if (record.status === "running") {
                record.status = "interrupted";
                record.error = error.message;
              }
            error.databaseQueries = structuredClone(databaseQueries);
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
                databaseQueries,
                networkRequests,
              });
            } catch (error) {
              error.scriptStage = "response-override";
              error.networkRequests = structuredClone(networkRequests);
              reject(error);
            }
          }
        })
        .catch((failure) => {
          // Cleanup failures must not strand the outer script promise. The owner
          // still finalizes its independent write receipt before returning.
          reject(failure);
        });
      return finishing;
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
      if (message.kind === "database") {
        if (
          databaseActive ||
          message.index !== nextDatabase ||
          !databaseOperations[nextDatabase]
        ) {
          finish(Error("数据库任务次序无效或重复调用"));
          return;
        }
        const operation = databaseOperations[nextDatabase++];
        databaseActive = true;
        const evidence = {
          index: message.index,
          connectionId: operation.connectionId,
          status: "running",
        };
        databaseQueries.push(evidence);
        let response, error;
        try {
          const result =
            operation.writeIntent === "redis-set"
              ? await executeNativeWrite(
                  nativeWrite,
                  operation,
                  nativePhase,
                  databaseOrdinals?.[message.index],
                  controller.signal,
                )
              : await databaseQuery(
                  {
                    connectionId: operation.connectionId,
                    sql: operation.query,
                    parameters: [],
                  },
                  controller.signal,
                );
          if (settled || controller.signal.aborted) return;
          response = {
            assignments: databaseAssignments(operation, result),
            ...(operation.isConsoleOutput === 1
              ? { rows: databaseResultRows(operation, result) }
              : {}),
          };
          if (Buffer.byteLength(JSON.stringify(response)) > 262144)
            throw Error("数据库任务结果超过256KiB");
          evidence.status = "completed";
        } catch (caught) {
          // Cancellation already records an interrupted query. A late driver
          // rejection must not rewrite that evidence or publish a worker reply.
          if (settled || controller.signal.aborted) return;
          error = String(caught.message).slice(0, 2000);
          evidence.status = "failed";
          evidence.error = error;
          response = undefined;
        } finally {
          databaseActive = false;
        }
        if (!settled)
          worker.postMessage({
            kind: "database",
            id: message.id,
            error,
            response,
          });
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
                activityCPUTimeUs: completedMessage.activityCPUTimeUs,
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
  const budgets = scriptBudgets(options);
  const deadline = performance.now() + budgets.wallBudgetMs;
  let remaining = budgets.activityBudgetMs,
    requestLimit = budgets.requestLimit,
    timerLimit = budgets.timerLimit,
    fakerLimit = budgets.fakerLimit,
    jobLimit = budgets.jobLimit,
    assertionLimit = budgets.assertionLimit,
    state = structuredClone(input);
  state.responseOverride = null;
  state.responseOriginals = null;
  state.responseWire = undefined;
  const logs = [],
    tests = [],
    networkRequests = [],
    sequenceActivity = [];
  for (const [stageIndex, stage] of stages.entries()) {
    if (!stage.code.trim()) continue;
    const wallBudgetMs = Math.min(2000, deadline - performance.now());
    if (remaining <= 0 || wallBudgetMs <= 0)
      throw Object.assign(Error("脚本执行超时"), {
        scriptStage: "sequence-budget",
        networkRequests,
        sequenceActivity,
      });
    let result;
    const stageStartedAt = performance.now();
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
      error.sequenceActivity = sequenceActivity;
      error.networkRequests = [
        ...networkRequests,
        ...(error.networkRequests || []).map((item) => ({
          ...item,
          scope: stage.name,
        })),
      ];
      throw error;
    }
    sequenceActivity.push({
      stageIndex,
      activityBudgetMs: remaining,
      activityMs: result.activityMs,
      elapsedMs: Math.round(performance.now() - stageStartedAt),
      fakerCalls: result.usage.fakerCalls,
      timerCount: result.usage.timers,
      requestCount: result.networkRequests.length,
      activityMetrics: { ...result.activityMetrics },
      activityCPUTimeUs: { ...result.activityCPUTimeUs },
    });
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
        sequenceActivity,
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
        sequenceActivity,
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
    activityMs: budgets.activityBudgetMs - remaining,
  };
}
