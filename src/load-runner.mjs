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
  const dataRows = parseLoadCSV(options.dataCSV);
  const count = Math.min(
    100,
    Math.max(1, Math.floor(Number(options.count)) || 10),
  );
  const concurrency = Math.min(
    10,
    Math.max(1, Math.floor(Number(options.concurrency)) || 1),
  );
  const environmentId = selectedEnvironment(project, options.environmentId).id;
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
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < count && !options.signal?.aborted) {
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
              signal: options.signal,
              cookieSession: memoryCookieSession(options.cookieState),
              variableScopes: {
                ...scopes,
                runtime: {
                  ...scopes.runtime,
                  ...(dataRows.length ? dataRows[index % dataRows.length] : {}),
                },
              },
              prepareRequest: (definition) =>
                resolveServiceRequest(project, definition, environmentId),
            },
          );
          const record = run.results[0];
          if (!record) {
            results.push({ index, error: "请求已取消", passed: false });
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
            ...(item.error ? { error: String(item.error).slice(0, 500) } : {}),
          }));
          results.push({
            index,
            status: record.response?.status,
            duration: record.response?.duration,
            elapsed: Date.now() - iterationStart,
            passed:
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
            error: String(error.message).slice(0, 1000),
            passed: false,
          });
        }
      }
    }),
  );
  const timings = results
    .filter((r) => r.duration !== undefined)
    .map((r) => r.duration)
    .sort((a, b) => a - b);
  return {
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
    cancelled: Boolean(options.signal?.aborted),
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
