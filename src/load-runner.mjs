import { normalizeRedirect } from "./http-redirect.mjs";
import { loadTiming } from "../public/load-timing.js";
import { parseLoadCSV } from "../public/load-data.js";
import { memoryCookieSession } from "./cookie-jar.mjs";
import { runPlan, snapshotPlan } from "./core.mjs";
import {
  freezeServiceBinding,
  resolveServiceRequest,
  selectedEnvironment,
  environmentVariables,
} from "./environments.mjs";
import { projectScopes } from "./variable-scopes.mjs";
import { executeRequest } from "./runtime.mjs";

export async function runLoad(project, request, options = {}) {
  if (request?.postmanCollectionId !== undefined)
    throw Error("压测暂不支持Postman collection作用域，请使用普通请求或计划");
  if (normalizeRedirect(request.redirect))
    throw Error("压测暂不支持 HTTP 重定向策略，请使用普通执行");
  const timing = loadTiming(options);
  const dataRows = parseLoadCSV(options.dataCSV);
  const count = Math.min(
    100,
    Math.max(1, Math.floor(Number(options.count)) || 10),
  );
  const concurrency = Math.min(
    10,
    Math.max(1, Math.floor(Number(options.concurrency)) || 1),
  );
  const selected = selectedEnvironment(project, options.environmentId);
  const environmentId = selected.id;
  const variables =
    options.variables || environmentVariables(project, environmentId);
  const scopes = projectScopes(project, environmentId, variables);
  const plan = snapshotPlan({
    name: "压测请求",
    functions: project.settings?.functions || [],
    steps: [{ request: freezeServiceBinding(project, request) }],
  });
  const results = [];
  let cursor = 0,
    mainRequests = 0;
  const started = Date.now();
  const controller = new AbortController();
  let stopReason, timer;
  const stop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    controller.abort();
  };
  const cancel = () => stop("cancelled");
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const deadline =
    timing.mode === "duration"
      ? started + timing.durationSeconds * 1000
      : Infinity;
  if (timing.mode === "duration" && !stopReason)
    timer = setTimeout(
      () => stop("duration"),
      Math.max(0, deadline - Date.now()),
    );
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < count && !controller.signal.aborted) {
          if (Date.now() >= deadline) {
            stop("duration");
            break;
          }
          const index = cursor++,
            iterationStart = Date.now();
          try {
            const run = await runPlan(
              plan,
              variables,
              async (definition, signal, transport) => {
                mainRequests++;
                return executeRequest(definition, signal, transport);
              },
              {
                signal: controller.signal,
                executionContext: {
                  environment: {
                    id: String(selected.id),
                    name: String(selected.name || ""),
                  },
                  iteration: index,
                  iterationCount: count,
                  iterationData: dataRows.length
                    ? dataRows[index % dataRows.length]
                    : {},
                },
                cookieSession: memoryCookieSession(options.cookieState),
                variableScopes: {
                  ...scopes,
                  runtime: {
                    ...scopes.runtime,
                    ...(dataRows.length
                      ? dataRows[index % dataRows.length]
                      : {}),
                  },
                },
                prepareRequest: (definition) =>
                  resolveServiceRequest(project, definition, environmentId),
              },
            );
            const record = run.results[0];
            if (!record) {
              results.push({
                index,
                error: "请求已中断",
                passed: false,
                interrupted: true,
              });
              continue;
            }
            const assertionFailures = (record.assertions || []).filter(
              (item) => !item.passed,
            );
            const subrequests = (record.subrequests || []).map((item) => ({
              phase: item.phase,
              status: item.status,
              method: item.request?.method,
              url: String(item.request?.url || "").slice(0, 512),
              responseStatus: item.response?.status,
              ...(item.error
                ? { error: String(item.error).slice(0, 500) }
                : {}),
            }));
            results.push({
              index,
              interrupted: run.status === "cancelled",
              status: record.response?.status,
              duration: record.response?.duration,
              elapsed: Date.now() - iterationStart,
              passed:
                run.status !== "cancelled" &&
                record.status === "passed" &&
                record.response?.status >= 200 &&
                record.response?.status < 300,
              assertionFailureCount: assertionFailures.length,
              assertionFailures: assertionFailures.slice(0, 10).map((item) => ({
                name: String(item.name || item.target || "assertion").slice(
                  0,
                  300,
                ),
                phase: item.phase,
                error: String(item.error || "断言未通过").slice(0, 500),
              })),
              subrequests,
              ...(record.error
                ? { error: String(record.error).slice(0, 1000) }
                : {}),
              ...(record.response &&
              (record.response.status < 200 || record.response.status >= 300)
                ? {
                    responsePreview: String(record.response.body || "").slice(
                      0,
                      1024,
                    ),
                  }
                : {}),
            });
          } catch (error) {
            results.push({
              index,
              interrupted: controller.signal.aborted,
              error: String(error.message).slice(0, 1000),
              passed: false,
            });
          }
        }
      }),
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
  stopReason ||= timing.mode === "duration" ? "count-limit" : "count";
  const timings = results
    .filter((r) => r.duration !== undefined)
    .map((r) => r.duration)
    .sort((a, b) => a - b);
  return {
    ...timing,
    stopReason,
    count: results.length,
    requested: count,
    concurrency,
    elapsed: Date.now() - started,
    passed: results.filter((r) => r.passed).length,
    timingSamples: timings.length,
    p50: timings[Math.floor(timings.length * 0.5)] || 0,
    p95:
      timings[
        Math.min(timings.length - 1, Math.floor(timings.length * 0.95))
      ] || 0,
    mainRequests,
    scriptRequests: results.reduce(
      (sum, r) => sum + (r.subrequests?.length || 0),
      0,
    ),
    variableIsolation: "per-request",
    cancelled: stopReason === "cancelled",
    dataRows: dataRows.length,
    results: results
      .sort((a, b) => a.index - b.index)
      .map((result) => ({
        ...result,
        ...(dataRows.length
          ? { dataRow: (result.index % dataRows.length) + 1 }
          : {}),
      })),
  };
}
